/**
 * deploy-tools' chain commands, written against injected services so the same code runs
 * against a live network (indexer, proof server, wallet) and against an in-process
 * ledger in tests. Every command writes its public record BEFORE it submits, submits
 * the recorded bytes once, tracks inclusion by transaction identifiers, and never
 * prints or records a secret.
 *
 * `publish` uses the library's publisher exactly as an adopter would: split each
 * message into 256-byte parts, one intent per message (several messages: one
 * transaction, one intent each), prove, balance, record, submit once, locate the
 * packages after inclusion and verify them from the raw bytes.
 *
 * @module
 */
import { existsSync, renameSync, writeFileSync } from "node:fs";

import {
  type CircuitResults,
  ContractState as RuntimeContractState,
  createConstructorContext,
} from "@midnight-ntwrk/compact-runtime";
import * as ledger from "@midnightntwrk/ledger-v9";

import {
  emitterAuthorityOf,
  type EmitterPrivateState,
  emitterWitnesses,
} from "../contract-examples/whitelist/whitelist.js";
import { jsonSafe } from "../src/cli/options.js";
import { verifierKeySha256 } from "../src/cli/verifier-key.js";
import {
  bindingFromContract,
  blockFullnessCheck,
  buildPackagesTransaction,
  deserializeFinal,
  type EmitPartCircuit,
  finalizeTransaction,
  type FinalizedRecord,
  type FinalizedTransactionRecord,
  finalizeTransactionPackages,
  locateRecord,
  type PackageRequest,
  type PinnedBlock,
  type PublicationBalancer,
  type PublicationProver,
  type PublicationStateSource,
  type PublicationSubmitter,
  splitPayload,
  submitRecord,
  submitSavedTransaction,
} from "../src/publisher/index.js";
import { bytesEqual, bytesToHex, hexToBytes } from "../src/reader/bytes.js";
import { deserializeTransaction, verifyTransactionPackages } from "../src/reader/transaction.js";
import { buildCircuitCallTransaction, callIntentCheck } from "./call.js";
import type { ExampleProfile, GeneratedModule } from "./contracts.js";
import { buildDeployTransaction, deployIntentCheck } from "./deploy.js";
import {
  createWitnessSecretFile,
  readSigningKeyFile,
  readWitnessSecret,
  writeSigningKeyFile,
} from "./secrets.js";
import type { DustRegistrationReport, PublicWalletIdentity, WalletBalances } from "./wallet.js";
import { WalletNotSyncedError } from "./wallet-sync.js";

/** A transaction the chain included. */
export interface IncludedTransaction {
  readonly hash: string;
  readonly rawHex: string;
  readonly status: string;
  readonly identifiers: readonly string[];
  readonly blockHeight: number;
  readonly blockHash: string;
}

/** What the chain commands need. */
export interface ChainServices {
  readonly network: string;
  readonly stateSource: PublicationStateSource;
  /** The latest block and its ledger parameters (the network's, never defaults). */
  readonly currentParameters: () => Promise<{
    readonly block: PinnedBlock;
    readonly ledgerParameters: ledger.LedgerParameters;
  }>;
  readonly prover: PublicationProver;
  readonly balancer: PublicationBalancer;
  readonly submitter: PublicationSubmitter;
  readonly coinPublicKey: string;
  /** A transaction carrying any of these identifiers, or `undefined` after `timeoutMs`. */
  readonly waitForInclusion: (
    identifiers: readonly string[],
    timeoutMs: number,
  ) => Promise<IncludedTransaction | undefined>;
  /** The contract's current serialized state, if it exists. */
  readonly contractState: (address: string) => Promise<Uint8Array | undefined>;
  readonly proofTimeoutMs: number;
  /** False only for offline tests with stand-in providers. */
  readonly requireProofs: boolean;
  readonly log: (line: string) => void;
  /** Secret files may be created inside a Git working tree (tests only). */
  readonly allowSecretsInRepository?: boolean;
}

/** A failed chain command (exit status 1), after anything it already recorded. */
export class CommandFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandFailure";
  }
}

/**
 * Write a public JSON record atomically (temporary file, then rename).
 */
export const writeRecord = (path: string, record: unknown): void => {
  const temporary = `${path}.tmp-${String(process.pid)}`;
  writeFileSync(temporary, `${JSON.stringify(jsonSafe(record), null, 2)}\n`);
  renameSync(temporary, path);
};

/**
 * Refuse a record path that already exists: a record is written before a submission
 * and must never overwrite the record of an earlier run.
 *
 * @throws {CommandFailure} If the file exists.
 */
export const assertNewRecord = (path: string): void => {
  if (existsSync(path)) {
    throw new CommandFailure(`the record ${path} already exists; choose a new path`);
  }
};

const inclusionTimeout = (ttl: Date): number =>
  Math.max(60_000, ttl.getTime() - Date.now() + 60_000);

const secretOptions = (services: ChainServices) =>
  services.allowSecretsInRepository === true ? { allowInsideRepository: true } : {};

// ----------------------------------------------------------------------------------
// funding
// ----------------------------------------------------------------------------------

/** The part of a wallet session `funding` uses. */
export interface FundingWallet {
  readonly identity: PublicWalletIdentity;
  balances(): Promise<WalletBalances>;
  registerForDust(mode: "estimate" | "register"): Promise<DustRegistrationReport>;
}

/** Public funding report: addresses and balances only. */
export interface FundingReport {
  readonly identity: PublicWalletIdentity;
  readonly balances: WalletBalances;
  readonly dustRegistration?: DustRegistrationReport;
}

/**
 * Run a wallet step that needs a complete sync. When the sync does not complete, print
 * "not synced" with the public progress and fail: no balance is ever printed from an
 * incomplete sync.
 */
const whenSynced = async <T>(step: () => Promise<T>, log: (line: string) => void): Promise<T> => {
  try {
    return await step();
  } catch (error) {
    if (!(error instanceof WalletNotSyncedError)) throw error;
    log(`not synced         ${error.detail}; ${error.reason}`);
    log("                   no balance is shown before the sync is complete; run it again");
    throw new CommandFailure(
      "the wallet is not synced, so its balances are unknown (not zero); run `funding` again, with --wallet-cache-file to resume",
    );
  }
};

/**
 * Print the wallet's public addresses and balances; optionally register NIGHT for DUST.
 * Balances are printed only after a complete sync; otherwise it prints "not synced"
 * with the progress and throws {@link CommandFailure}.
 */
export const runFunding = async (
  wallet: FundingWallet,
  options: { readonly registerDust?: "estimate" | "register" },
  log: (line: string) => void,
): Promise<FundingReport> => {
  const { identity } = wallet;
  log(`network            ${identity.networkId}`);
  log(`unshielded address ${identity.unshieldedAddress}`);
  log(`shielded address   ${identity.shieldedAddress}`);
  log(`DUST address       ${identity.dustAddress}`);
  log(`coin public key    ${identity.coinPublicKey}`);
  const balances = await whenSynced(() => wallet.balances(), log);
  log(
    `NIGHT              ${balances.night.toString()} STAR (${String(balances.nightUtxos.length)} UTxO)`,
  );
  for (const utxo of balances.nightUtxos) {
    log(
      `  UTxO ${utxo.intentHash}#${String(utxo.outputNo)} ${utxo.value.toString()} STAR, created ${utxo.ctime}, DUST registration ${utxo.registeredForDustGeneration ? "yes" : "no"}`,
    );
  }
  log(`DUST               ${balances.dust.toString()} SPECK`);
  if (options.registerDust === undefined) return { identity, balances };
  const registerDust = options.registerDust;
  const dustRegistration = await whenSynced(() => wallet.registerForDust(registerDust), log);
  log(
    `DUST registration  ${dustRegistration.mode}: ${String(dustRegistration.unregistered)} unregistered UTxO` +
      (dustRegistration.fee === undefined ? "" : `, fee ${dustRegistration.fee.toString()} SPECK`) +
      (dustRegistration.transactionId === undefined
        ? ""
        : `, transaction ${dustRegistration.transactionId}`) +
      (dustRegistration.note === undefined ? "" : ` (${dustRegistration.note})`),
  );
  return { identity, balances, dustRegistration };
};

// ----------------------------------------------------------------------------------
// deploy
// ----------------------------------------------------------------------------------

/** Options of {@link runDeploy}. */
export interface DeployOptions {
  readonly profile: ExampleProfile;
  readonly generated: GeneratedModule;
  readonly verifierKeys: Readonly<Record<string, Uint8Array>>;
  /** Where the emitter secret is created (or read with `reuseSecret`). */
  readonly emitterSecretFile: string;
  readonly reuseSecret?: boolean;
  /** Where the maintenance signing key is created (or read with `reuseMaintenanceKey`). */
  readonly maintenanceKeyFile: string;
  readonly reuseMaintenanceKey?: boolean;
  readonly ttlSeconds: number;
  /** Public deployment record, rewritten at every stage (must not exist yet). */
  readonly out: string;
}

/** Public deployment record. */
export interface DeploymentRecord {
  readonly kind: "deployment";
  readonly stage: "built" | "finalized" | "submitted" | "included" | "verified";
  readonly example: ExampleProfile["name"];
  readonly eventName: string;
  readonly network: string;
  readonly address: string;
  readonly operations: readonly string[];
  readonly verifierKeySha256: Readonly<Record<string, string>>;
  readonly maintenanceVerifyingKey: ledger.SignatureVerifyingKey;
  /** The public authority commitment of the example whitelist. */
  readonly emitterAuthority: string;
  readonly finalized?: FinalizedTransactionRecord;
  readonly submittedId?: string;
  readonly inclusion?: IncludedTransaction;
}

/**
 * Deploy an example: create the emitter secret file (the whitelist stores its
 * commitment) and the maintenance signing key file, build an explicit `ContractDeploy`
 * with the committed verifier keys, record the address before submission, submit once,
 * wait for inclusion and check the deployed state (operations, verifier keys,
 * maintenance authority, authority commitment).
 */
export const runDeploy = async (
  services: ChainServices,
  options: DeployOptions,
): Promise<DeploymentRecord> => {
  const { profile } = options;
  assertNewRecord(options.out);
  if (options.reuseSecret !== true) {
    createWitnessSecretFile(options.emitterSecretFile, secretOptions(services));
  }
  const secret = readWitnessSecret(options.emitterSecretFile);
  let authority: Uint8Array;
  try {
    authority = emitterAuthorityOf(secret);
    const onChainRule = options.generated.pureCircuits.emitterAuthorityOf?.(secret);
    if (!(onChainRule instanceof Uint8Array) || !bytesEqual(onChainRule, authority)) {
      throw new CommandFailure("the contract's emitterAuthorityOf disagrees with the client's");
    }
  } finally {
    secret.fill(0);
  }
  if (options.reuseMaintenanceKey !== true) {
    writeSigningKeyFile(
      options.maintenanceKeyFile,
      ledger.sampleSigningKey(),
      secretOptions(services),
    );
  }
  const signingKey = readSigningKeyFile(options.maintenanceKeyFile);
  const maintenanceVerifyingKey = ledger.signatureVerifyingKey(signingKey as ledger.SigningKey);
  const contract = new options.generated.Contract(emitterWitnesses);
  const constructed = await contract.initialState(
    createConstructorContext<EmitterPrivateState>(
      { emitterSecret: new Uint8Array(32) },
      services.coinPublicKey,
    ),
    authority,
  );
  const { block, ledgerParameters } = await services.currentParameters();
  const ttl = new Date((block.timestampSeconds + options.ttlSeconds) * 1000);
  const built = buildDeployTransaction({
    network: services.network,
    initialState: constructed.currentContractState,
    verifierKeys: options.verifierKeys,
    maintenanceCommittee: [maintenanceVerifyingKey],
    ttl,
  });
  let record: DeploymentRecord = {
    kind: "deployment",
    stage: "built",
    example: profile.name,
    eventName: profile.eventName,
    network: services.network,
    address: built.address,
    operations: built.operations,
    verifierKeySha256: built.verifierKeyHashes,
    maintenanceVerifyingKey,
    emitterAuthority: bytesToHex(authority),
  };
  const save = (next: DeploymentRecord) => {
    record = next;
    writeRecord(options.out, record);
  };
  save(record);
  services.log(`contract address   ${built.address} (recorded before submission)`);
  const check = deployIntentCheck(built);
  const finalized = await finalizeTransaction(
    { prover: services.prover, balancer: services.balancer },
    built.transaction,
    {
      network: services.network,
      purpose: `deploy ${profile.name}`,
      proofTimeoutMs: services.proofTimeoutMs,
      ttl,
      ledgerParameters,
      block,
      check,
      costCheck: blockFullnessCheck(1),
      requireProofs: services.requireProofs,
    },
  );
  save({ ...record, stage: "finalized", finalized });
  const submittedId = await submitSavedTransaction(services.submitter, finalized, check, {
    requireProofs: services.requireProofs,
  });
  save({ ...record, stage: "submitted", finalized, submittedId });
  services.log(`submitted          ${submittedId}`);
  const inclusion = await services.waitForInclusion(finalized.identifiers, inclusionTimeout(ttl));
  if (inclusion === undefined) {
    throw new CommandFailure(
      `the deployment was not seen before its TTL; inspect ${built.address} before trying again (never deploy twice blindly)`,
    );
  }
  save({ ...record, stage: "included", finalized, submittedId, inclusion });
  services.log(
    `included           ${inclusion.hash} at block ${String(inclusion.blockHeight)}, status ${inclusion.status}`,
  );
  if (inclusion.status !== "SUCCESS") {
    throw new CommandFailure(`deployment status ${inclusion.status}`);
  }
  const stateBytes = await services.contractState(built.address);
  if (stateBytes === undefined) {
    throw new CommandFailure("the deployed contract is not visible yet");
  }
  const deployed = ledger.ContractState.deserialize(stateBytes);
  for (const [circuit, hash] of Object.entries(built.verifierKeyHashes)) {
    const key = deployed.operation(circuit)?.verifierKey;
    if (key === undefined || verifierKeySha256(key) !== hash) {
      throw new CommandFailure(`deployed ${circuit} verifier key differs from the committed one`);
    }
  }
  const committee = deployed.maintenanceAuthority.committee;
  if (
    deployed.maintenanceAuthority.threshold !== 1 ||
    committee.length !== 1 ||
    committee[0]?.value !== maintenanceVerifyingKey.value
  ) {
    throw new CommandFailure("the deployed maintenance authority is not the recorded key");
  }
  const onChain = options.generated.ledger(
    RuntimeContractState.deserialize(stateBytes).data,
  ).emitterAuthority;
  if (!(onChain instanceof Uint8Array) || !bytesEqual(onChain, authority)) {
    throw new CommandFailure("the deployed emitter authority differs from the recorded one");
  }
  save({ ...record, stage: "verified", finalized, submittedId, inclusion });
  services.log("verified           operations, verifier keys, maintenance authority, authority");
  return record;
};

// ----------------------------------------------------------------------------------
// publish
// ----------------------------------------------------------------------------------

/** Options of {@link runPublish}. */
export interface PublishOptions {
  readonly profile: ExampleProfile;
  readonly generated: GeneratedModule;
  /** The deployed example. */
  readonly address: string;
  /** One payload per package, in order (several: one transaction, one intent each). */
  readonly messages: readonly Uint8Array[];
  /** The emitter secret file (the whitelist's witness). */
  readonly secretFile: string;
  readonly maxParts: number;
  readonly ttlSeconds: number;
  /** Largest fraction of a block any cost dimension may use (default 1). */
  readonly maxBlockFraction?: number;
  /** Public record, written before submission (must not exist yet). */
  readonly out: string;
  /** Build, prove, balance and record, but do not submit. */
  readonly dryRun?: boolean;
}

/** One package's outcome after inclusion. */
export interface PublishedPackage {
  readonly segment: number;
  readonly parts: number;
  /** The package verified from the included raw bytes: placement and merged payload. */
  readonly verified: boolean;
  readonly issues: readonly string[];
}

/** Public publication record. */
export interface PublicationRecord {
  readonly kind: "publication";
  readonly stage: "finalized" | "submitted" | "included" | "verified";
  readonly example: ExampleProfile["name"];
  readonly eventName: string;
  readonly network: string;
  readonly contract: string;
  /** Size and SHA-256 of each message (the payloads are public in `finalized`). */
  readonly messages: readonly { readonly bytes: number; readonly sha256: string }[];
  /** The finalized public bytes, identifiers and each package's intent. */
  readonly finalized: FinalizedRecord;
  /** Normalized cost of the finalized transaction (fractions of a block). */
  readonly normalizedCost: Readonly<Record<string, number>>;
  readonly submittedId?: string;
  readonly inclusion?: IncludedTransaction;
  /** Others merged intents into the transaction before inclusion. */
  readonly merged?: boolean;
  readonly packages?: readonly PublishedPackage[];
}

const sha256Hex = (bytes: Uint8Array): string => verifierKeySha256(bytes);

/**
 * Publish one or several messages to an example: one package per message, all
 * packages in one transaction, one intent each; prove, balance, record the finalized
 * public bytes, submit them once, wait for inclusion by identifier, locate every
 * package's intent and verify each package from the included raw bytes.
 */
export const runPublish = async (
  services: ChainServices,
  options: PublishOptions,
): Promise<PublicationRecord> => {
  assertNewRecord(options.out);
  if (options.messages.length === 0) throw new RangeError("give at least one message");
  const secret = readWitnessSecret(options.secretFile);
  try {
    const contract = new options.generated.Contract(emitterWitnesses);
    const emitPart = contract.impureCircuits[options.profile.entryPoint];
    if (emitPart === undefined) {
      throw new CommandFailure(`the contract has no ${options.profile.entryPoint} circuit`);
    }
    const binding = bindingFromContract<EmitterPrivateState, "emitPart">(
      { impureCircuits: { emitPart: emitPart as unknown as EmitPartCircuit<EmitterPrivateState> } },
      options.profile.entryPoint,
      () => ({ emitterSecret: secret }),
    );
    const requests: PackageRequest<EmitterPrivateState>[] = options.messages.map((message) => ({
      contract: options.address,
      name: options.profile.eventName,
      binding,
      parts: splitPayload(message),
    }));
    const built = await buildPackagesTransaction(
      services.stateSource,
      {
        network: services.network,
        coinPublicKey: services.coinPublicKey,
        maxParts: options.maxParts,
        ttlSeconds: options.ttlSeconds,
      },
      requests,
    );
    services.log(
      `built              ${String(built.packages.length)} package(s) (${built.packages.map((pkg) => `${String(pkg.parts.length)} part(s) at segment ${String(pkg.segment)}`).join(", ")}) on block ${String(built.block.height)}`,
    );
    const finalized = await finalizeTransactionPackages(
      { prover: services.prover, balancer: services.balancer },
      built,
      {
        proofTimeoutMs: services.proofTimeoutMs,
        costCheck: blockFullnessCheck(options.maxBlockFraction ?? 1),
        requireProofs: services.requireProofs,
      },
    );
    const finalTx = deserializeFinal(hexToBytes(finalized.transactionHex), services.requireProofs);
    const normalizedCost = {
      ...built.ledgerParameters.normalizeFullness(finalTx.cost(built.ledgerParameters, true)),
    };
    let record: PublicationRecord = {
      kind: "publication",
      stage: "finalized",
      example: options.profile.name,
      eventName: options.profile.eventName,
      network: services.network,
      contract: options.address,
      messages: options.messages.map((message) => ({
        bytes: message.byteLength,
        sha256: sha256Hex(message),
      })),
      finalized,
      normalizedCost,
    };
    const save = (next: PublicationRecord) => {
      record = next;
      writeRecord(options.out, record);
    };
    save(record);
    services.log(
      `finalized          ${String(finalized.transactionHex.length / 2)} bytes; block usage ${normalizedCost.blockUsage?.toFixed(4) ?? "?"} of a block; recorded before submission`,
    );
    if (options.dryRun === true) return record;
    const submittedId = await submitRecord(services.submitter, finalized, {
      requireProofs: services.requireProofs,
    });
    save({ ...record, stage: "submitted", submittedId });
    services.log(`submitted          ${submittedId}`);
    const inclusion = await services.waitForInclusion(
      finalized.identifiers,
      inclusionTimeout(built.ttl),
    );
    if (inclusion === undefined) {
      throw new CommandFailure(
        "the publication was not seen before its TTL; it was not included. Inspect public state; do not resubmit blindly",
      );
    }
    const included = deserializeTransaction(hexToBytes(inclusion.rawHex));
    const location = locateRecord(included, finalized);
    save({ ...record, stage: "included", inclusion, merged: location.merged });
    if (!location.contains) {
      throw new CommandFailure(
        `the included transaction does not contain the packages: ${location.reason ?? ""}`,
      );
    }
    const verification = verifyTransactionPackages(included, {
      contract: options.address,
      entryPoint: options.profile.entryPoint,
      name: options.profile.eventName,
      network: services.network,
      status: inclusion.status,
      transactionHash: inclusion.hash,
    });
    const packages: PublishedPackage[] = finalized.packages.map((pkg) => {
      const expected = hexToBytes(pkg.partsHex.join(""));
      const found = verification.packages.find((entry) => entry.package.segment === pkg.segment);
      const issues = [
        ...verification.issues,
        ...(found === undefined ? ["no package at this segment"] : found.placement),
        ...(found?.package.issues ?? []),
      ];
      const verified =
        issues.length === 0 &&
        found?.package.payload !== undefined &&
        bytesEqual(found.package.payload, expected);
      return {
        segment: pkg.segment,
        parts: pkg.partsHex.length,
        verified,
        issues: verified || issues.length > 0 ? issues : ["the merged payload differs"],
      };
    });
    const allVerified = packages.every((pkg) => pkg.verified);
    save({
      ...record,
      stage: allVerified ? "verified" : "included",
      submittedId,
      inclusion,
      merged: location.merged,
      packages,
    });
    services.log(
      `included           ${inclusion.hash} at block ${String(inclusion.blockHeight)}, status ${inclusion.status}${location.merged ? " (others merged intents into it)" : ""}`,
    );
    for (const pkg of packages) {
      services.log(
        `package            segment ${String(pkg.segment)}, ${String(pkg.parts)} part(s): ${pkg.verified ? "verified from the raw bytes" : `NOT verified: ${pkg.issues.join("; ")}`}`,
      );
    }
    if (!allVerified) throw new CommandFailure("a package did not verify from the raw bytes");
    return record;
  } finally {
    secret.fill(0);
  }
};

// ----------------------------------------------------------------------------------
// pin (the notice board's state-changing circuit)
// ----------------------------------------------------------------------------------

/** Options of {@link runPin}. */
export interface PinOptions {
  readonly profile: ExampleProfile;
  readonly generated: GeneratedModule;
  /** The deployed notice board. */
  readonly address: string;
  /** The 32-byte digest to pin. */
  readonly digest: Uint8Array;
  readonly secretFile: string;
  readonly ttlSeconds: number;
  /** Public record, written before submission (must not exist yet). */
  readonly out: string;
}

/** Public record of a pin. */
export interface PinRecord {
  readonly kind: "pin";
  readonly stage: "finalized" | "submitted" | "included" | "verified";
  readonly network: string;
  readonly contract: string;
  readonly digest: string;
  readonly finalized: FinalizedTransactionRecord;
  readonly submittedId?: string;
  readonly inclusion?: IncludedTransaction;
  readonly pinnedCount?: string;
}

/**
 * Call the notice board's `pin(digest)` in a transaction of its own (it writes state,
 * so it is never batched with parts), then check the board's state.
 */
export const runPin = async (services: ChainServices, options: PinOptions): Promise<PinRecord> => {
  assertNewRecord(options.out);
  if (options.profile.name !== "notice-board") {
    throw new RangeError("pin is the notice board's circuit (--example notice-board)");
  }
  if (options.digest.byteLength !== 32) throw new RangeError("the digest is 32 bytes");
  const secret = readWitnessSecret(options.secretFile);
  try {
    const contract = new options.generated.Contract(emitterWitnesses);
    const pin = contract.impureCircuits.pin;
    if (pin === undefined) throw new CommandFailure("the contract has no pin circuit");
    const before = await services.contractState(options.address);
    const countOf = (state: Uint8Array | undefined): bigint | undefined => {
      if (state === undefined) return undefined;
      const count = options.generated.ledger(
        RuntimeContractState.deserialize(state).data,
      ).pinnedCount;
      return typeof count === "bigint" ? count : undefined;
    };
    const countBefore = countOf(before);
    const built = await buildCircuitCallTransaction<EmitterPrivateState>(services.stateSource, {
      network: services.network,
      address: options.address,
      circuit: "pin",
      coinPublicKey: services.coinPublicKey,
      privateState: { emitterSecret: secret },
      execute: async (context) =>
        (await pin(context, options.digest)) as CircuitResults<EmitterPrivateState, unknown>,
      ttlSeconds: options.ttlSeconds,
    });
    const check = callIntentCheck(built);
    const finalized = await finalizeTransaction(
      { prover: services.prover, balancer: services.balancer },
      built.transaction,
      {
        network: services.network,
        purpose: "pin",
        proofTimeoutMs: services.proofTimeoutMs,
        ttl: built.ttl,
        ledgerParameters: built.ledgerParameters,
        block: built.block,
        check,
        costCheck: blockFullnessCheck(1),
        requireProofs: services.requireProofs,
      },
    );
    let record: PinRecord = {
      kind: "pin",
      stage: "finalized",
      network: services.network,
      contract: options.address,
      digest: bytesToHex(options.digest),
      finalized,
    };
    const save = (next: PinRecord) => {
      record = next;
      writeRecord(options.out, record);
    };
    save(record);
    const submittedId = await submitSavedTransaction(services.submitter, finalized, check, {
      requireProofs: services.requireProofs,
    });
    save({ ...record, stage: "submitted", submittedId });
    services.log(`submitted          pin ${bytesToHex(options.digest)}: ${submittedId}`);
    const inclusion = await services.waitForInclusion(
      finalized.identifiers,
      inclusionTimeout(built.ttl),
    );
    if (inclusion === undefined) {
      throw new CommandFailure("the pin was not seen before its TTL; inspect public state");
    }
    save({ ...record, stage: "included", submittedId, inclusion });
    services.log(
      `included           ${inclusion.hash} at block ${String(inclusion.blockHeight)}, status ${inclusion.status}`,
    );
    if (inclusion.status !== "SUCCESS") throw new CommandFailure(`pin status ${inclusion.status}`);
    const after = await services.contractState(options.address);
    const view =
      after === undefined
        ? undefined
        : options.generated.ledger(RuntimeContractState.deserialize(after).data);
    const countAfter = countOf(after);
    if (
      view === undefined ||
      !(view.pinnedDigest instanceof Uint8Array) ||
      !bytesEqual(view.pinnedDigest, options.digest) ||
      countAfter === undefined ||
      (countBefore !== undefined && countAfter !== countBefore + 1n)
    ) {
      throw new CommandFailure("the board's state does not show the pin");
    }
    save({
      ...record,
      stage: "verified",
      submittedId,
      inclusion,
      pinnedCount: countAfter.toString(),
    });
    services.log(`verified           pinnedDigest set; pinnedCount ${countAfter.toString()}`);
    return record;
  } finally {
    secret.fill(0);
  }
};
