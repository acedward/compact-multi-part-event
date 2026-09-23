/**
 * The CLI's chain commands, written against injected services so the same code runs
 * against stagenet (indexer, proof server, wallet) and against an in-process ledger in
 * tests. Every command persists public records BEFORE it submits, tracks inclusion by
 * transaction identifiers, and never prints or records a secret.
 *
 * @module
 */
import { renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

import {
  ContractState as RuntimeContractState,
  createConstructorContext,
} from "@midnight-ntwrk/compact-runtime";
import * as ledger from "@midnightntwrk/ledger-v9";

import {
  createWitnessSecretFile,
  readSigningKeyFile,
  readWitnessSecret,
  writeSigningKeyFile,
} from "../adapters/secrets.js";
import type {
  DustRegistrationReport,
  PublicWalletIdentity,
  WalletBalances,
} from "../adapters/wallet.js";
import { bytesEqual, bytesToHex, hexToBytes } from "../codec/bytes.js";
import { deserializeTransaction, verifyPublicationTransaction } from "../codec/raw-transaction.js";
import { encodePublication } from "../codec/writer.js";
import {
  emitterAuthorityOf,
  emitterWitnesses,
  messageOwnerOf,
  messageOwnerWitnesses,
} from "../contract/index.js";
import {
  bindingFromContract,
  blockFullnessCheck,
  buildCircuitCallTransaction,
  buildDeployTransaction,
  buildPublicationTransaction,
  callIntentCheck,
  deployIntentCheck,
  type EmitPartCircuit,
  finalizePublication,
  type FinalizedPublication,
  finalizeTransaction,
  type FinalizedTransactionRecord,
  locatePublication,
  type PinnedBlock,
  type PublicationBalancer,
  type PublicationProver,
  type PublicationStateSource,
  type PublicationSubmitter,
  submitPublication,
  submitSavedTransaction,
} from "../transaction/index.js";
import type { ContractProfile, GeneratedModule } from "./contracts.js";

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

/** JSON-safe copy: bigints as decimal strings, bytes as hex. */
export const jsonSafe = (value: unknown): unknown => {
  if (typeof value === "bigint") return value.toString(10);
  if (value instanceof Uint8Array) return bytesToHex(value);
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonSafe(item)]));
  }
  return value;
};

/** Write a public JSON record atomically (temporary file, then rename). */
export const writeRecord = (path: string, record: unknown): void => {
  const temporary = `${path}.tmp-${String(process.pid)}`;
  writeFileSync(temporary, `${JSON.stringify(jsonSafe(record), null, 2)}\n`);
  renameSync(temporary, path);
};

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const inclusionTimeout = (ttl: Date): number =>
  Math.max(60_000, ttl.getTime() - Date.now() + 60_000);

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

/** Print the wallet's public addresses and balances; optionally register NIGHT for DUST. */
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
  const balances = await wallet.balances();
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
  const dustRegistration = await wallet.registerForDust(options.registerDust);
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
// deploy / deploy-consumer
// ----------------------------------------------------------------------------------

/** Options of {@link runDeploy}. */
export interface DeployOptions {
  readonly profile: ContractProfile;
  readonly generated: GeneratedModule;
  readonly verifierKeys: Readonly<Record<string, Uint8Array>>;
  /** Whitelist contracts: where the emitter secret is created (or read with `reuseSecret`). */
  readonly emitterSecretFile?: string;
  readonly reuseSecret?: boolean;
  /** Where the maintenance signing key is created (or read with `reuseMaintenanceKey`). */
  readonly maintenanceKeyFile: string;
  readonly reuseMaintenanceKey?: boolean;
  readonly ttlSeconds: number;
  /** Public deployment record, rewritten at every stage. */
  readonly out?: string;
}

/** Public deployment record. */
export interface DeploymentRecord {
  readonly kind: "deployment";
  readonly stage: "built" | "finalized" | "submitted" | "included" | "verified";
  readonly contract: ContractProfile["name"];
  readonly access: ContractProfile["access"];
  readonly network: string;
  readonly address: string;
  readonly operations: readonly string[];
  readonly verifierKeySha256: Readonly<Record<string, string>>;
  readonly maintenanceVerifyingKey: ledger.SignatureVerifyingKey;
  /** Whitelist only: the public authority commitment. */
  readonly emitterAuthority?: string;
  readonly finalized?: FinalizedTransactionRecord;
  readonly submittedId?: string;
  readonly inclusion?: IncludedTransaction;
}

const prepareMaintenanceKey = (options: DeployOptions, services: ChainServices) => {
  if (options.reuseMaintenanceKey === true) return readSigningKeyFile(options.maintenanceKeyFile);
  const key = ledger.sampleSigningKey();
  writeSigningKeyFile(
    options.maintenanceKeyFile,
    key,
    services.allowSecretsInRepository === true ? { allowInsideRepository: true } : {},
  );
  return readSigningKeyFile(options.maintenanceKeyFile);
};

const prepareEmitterSecret = (options: DeployOptions, services: ChainServices): Uint8Array => {
  const path = options.emitterSecretFile;
  if (path === undefined)
    throw new CommandFailure("the whitelist emitter needs --emitter-secret-file");
  if (options.reuseSecret !== true) {
    createWitnessSecretFile(
      path,
      services.allowSecretsInRepository === true ? { allowInsideRepository: true } : {},
    );
  }
  return readWitnessSecret(path);
};

/**
 * Deploy the reference emitter (whitelist: creates the emitter secret file, stores its
 * commitment) or the consumer (registry: no constructor arguments). Records the address
 * before submitting, waits for inclusion and checks the deployed state.
 */
export const runDeploy = async (
  services: ChainServices,
  options: DeployOptions,
): Promise<DeploymentRecord> => {
  const { profile } = options;
  let authority: Uint8Array | undefined;
  let args: unknown[] = [];
  let privateState: object;
  if (profile.access === "whitelist") {
    const secret = prepareEmitterSecret(options, services);
    try {
      authority = emitterAuthorityOf(secret);
      const onChainRule = options.generated.pureCircuits.emitterAuthorityOf?.(secret);
      if (!(onChainRule instanceof Uint8Array) || !bytesEqual(onChainRule, authority)) {
        throw new CommandFailure("the contract's emitterAuthorityOf disagrees with the client's");
      }
    } finally {
      secret.fill(0);
    }
    args = [authority];
    privateState = { emitterSecret: new Uint8Array(32) };
  } else {
    privateState = { messageOwnerSecret: new Uint8Array(32) };
  }
  const signingKey = prepareMaintenanceKey(options, services);
  const maintenanceVerifyingKey = ledger.signatureVerifyingKey(signingKey as ledger.SigningKey);
  const contract = new options.generated.Contract(
    profile.access === "whitelist" ? emitterWitnesses : messageOwnerWitnesses,
  );
  const constructed = await contract.initialState(
    createConstructorContext(privateState, services.coinPublicKey),
    ...args,
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
    contract: profile.name,
    access: profile.access,
    network: services.network,
    address: built.address,
    operations: built.operations,
    verifierKeySha256: built.verifierKeyHashes,
    maintenanceVerifyingKey,
    ...(authority === undefined ? {} : { emitterAuthority: bytesToHex(authority) }),
  };
  const save = (next: DeploymentRecord) => {
    record = next;
    if (options.out !== undefined) writeRecord(options.out, record);
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
  save({ ...record, stage: "submitted", submittedId });
  services.log(`submitted          ${submittedId}`);
  const inclusion = await services.waitForInclusion(finalized.identifiers, inclusionTimeout(ttl));
  if (inclusion === undefined) {
    throw new CommandFailure(
      `the deployment was not seen before its TTL; inspect ${built.address} before trying again (never deploy twice blindly)`,
    );
  }
  save({ ...record, stage: "included", inclusion });
  services.log(
    `included           ${inclusion.hash} at block ${String(inclusion.blockHeight)}, status ${inclusion.status}`,
  );
  if (inclusion.status !== "SUCCESS")
    throw new CommandFailure(`deployment status ${inclusion.status}`);
  const stateBytes = await services.contractState(built.address);
  if (stateBytes === undefined)
    throw new CommandFailure("the deployed contract is not visible yet");
  const deployed = ledger.ContractState.deserialize(stateBytes);
  for (const [circuit, hash] of Object.entries(built.verifierKeyHashes)) {
    const key = deployed.operation(circuit)?.verifierKey;
    if (key === undefined || sha256(key) !== hash) {
      throw new CommandFailure(`deployed ${circuit} verifier key differs from the repository's`);
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
  if (authority !== undefined) {
    const onChain = options.generated.ledger(
      RuntimeContractState.deserialize(stateBytes).data,
    ).emitterAuthority;
    if (!(onChain instanceof Uint8Array) || !bytesEqual(onChain, authority)) {
      throw new CommandFailure("the deployed emitter authority differs from the recorded one");
    }
  }
  save({ ...record, stage: "verified", inclusion });
  services.log(`verified           operations, verifier keys and maintenance authority`);
  return record;
};

// ----------------------------------------------------------------------------------
// register (consumer)
// ----------------------------------------------------------------------------------

/** Options of {@link runRegister}. */
export interface RegisterOptions {
  readonly profile: ContractProfile;
  readonly generated: GeneratedModule;
  readonly address: string;
  readonly message: Uint8Array;
  readonly ownerSecretFile: string;
  /** Create a new owner secret file first. */
  readonly createOwnerSecret?: boolean;
  readonly ttlSeconds: number;
  readonly out?: string;
  /** Provable circuits of the contract (to find `register<N>`). */
  readonly circuits: readonly string[];
}

/** Public registration record. */
export interface RegistrationRecord {
  readonly kind: "registration";
  readonly network: string;
  readonly address: string;
  readonly circuit: string;
  readonly requestId: string;
  readonly parts: number;
  readonly ownerCommitment: string;
  readonly finalized: FinalizedTransactionRecord;
  readonly submittedId?: string;
  readonly inclusion?: IncludedTransaction;
}

/**
 * Register a message with the consumer's `register<N>` in its own transaction (the
 * tails stay private in this proof; publishing in the same transaction would expose
 * them in the mempool before the registration lands).
 */
export const runRegister = async (
  services: ChainServices,
  options: RegisterOptions,
): Promise<RegistrationRecord> => {
  const publication = encodePublication(options.message);
  const parts = publication.parts.length;
  const circuit = `register${String(parts)}`;
  if (!options.circuits.includes(circuit)) {
    const sizes = options.circuits.filter((name) => /^register\d+$/u.test(name));
    throw new CommandFailure(
      `the message has ${String(parts)} parts, but the contract exports no ${circuit} (it has ${sizes.join(", ") || "none"})`,
    );
  }
  if (options.createOwnerSecret === true) {
    createWitnessSecretFile(
      options.ownerSecretFile,
      services.allowSecretsInRepository === true ? { allowInsideRepository: true } : {},
    );
  }
  const secret = readWitnessSecret(options.ownerSecretFile);
  const ownerCommitment = bytesToHex(messageOwnerOf(secret));
  const contract = new options.generated.Contract(messageOwnerWitnesses);
  const execute = contract.impureCircuits[circuit];
  if (execute === undefined) throw new CommandFailure(`no circuit ${circuit}`);
  try {
    const built = await buildCircuitCallTransaction<unknown>(services.stateSource, {
      network: services.network,
      address: options.address,
      circuit,
      coinPublicKey: services.coinPublicKey,
      privateState: { messageOwnerSecret: secret },
      execute: (context) =>
        execute(
          context,
          publication.requestId,
          publication.parts.map((part) => part.tail),
        ),
      ttlSeconds: options.ttlSeconds,
    });
    const check = callIntentCheck(built);
    const finalized = await finalizeTransaction(
      { prover: services.prover, balancer: services.balancer },
      built.transaction,
      {
        network: services.network,
        purpose: circuit,
        proofTimeoutMs: services.proofTimeoutMs,
        ttl: built.ttl,
        ledgerParameters: built.ledgerParameters,
        block: built.block,
        check,
        costCheck: blockFullnessCheck(1),
        requireProofs: services.requireProofs,
      },
    );
    let record: RegistrationRecord = {
      kind: "registration",
      network: services.network,
      address: options.address,
      circuit,
      requestId: bytesToHex(publication.requestId),
      parts,
      ownerCommitment,
      finalized,
    };
    if (options.out !== undefined) writeRecord(options.out, record);
    const submittedId = await submitSavedTransaction(services.submitter, finalized, check, {
      requireProofs: services.requireProofs,
    });
    record = { ...record, submittedId };
    if (options.out !== undefined) writeRecord(options.out, record);
    services.log(
      `registration       ${circuit} for request ${record.requestId}, submitted ${submittedId}`,
    );
    const inclusion = await services.waitForInclusion(
      finalized.identifiers,
      inclusionTimeout(built.ttl),
    );
    if (inclusion === undefined) {
      throw new CommandFailure(
        "the registration was not seen before its TTL; inspect public state",
      );
    }
    record = { ...record, inclusion };
    if (options.out !== undefined) writeRecord(options.out, record);
    if (inclusion.status !== "SUCCESS")
      throw new CommandFailure(`registration status ${inclusion.status}`);
    const stateBytes = await services.contractState(options.address);
    const registry =
      stateBytes === undefined
        ? undefined
        : (options.generated.ledger(RuntimeContractState.deserialize(stateBytes).data)
            .messageOwner as {
            member(key: Uint8Array): boolean;
            lookup(key: Uint8Array): Uint8Array;
          });
    const stored =
      registry?.member(publication.requestId) === true
        ? registry.lookup(publication.requestId)
        : undefined;
    if (stored === undefined || bytesToHex(stored) !== ownerCommitment) {
      throw new CommandFailure(
        "the registry does not hold the owner commitment for this request id",
      );
    }
    services.log(
      `included           ${inclusion.hash} at block ${String(inclusion.blockHeight)}; registry holds the owner commitment`,
    );
    return record;
  } finally {
    secret.fill(0);
  }
};

// ----------------------------------------------------------------------------------
// publish
// ----------------------------------------------------------------------------------

/** Options of {@link runPublish}. */
export interface PublishOptions {
  readonly profile: ContractProfile;
  readonly generated: GeneratedModule;
  readonly address: string;
  readonly message: Uint8Array;
  /** Whitelist: the emitter secret file; registry: the owner secret file. */
  readonly secretFile: string;
  readonly maxParts: number;
  readonly ttlSeconds: number;
  /** Largest fraction of a block any cost dimension may use (default 1). */
  readonly maxBlockFraction?: number;
  /** Where the finalized public record is written before submission. */
  readonly recordOut?: string;
  /** Build, prove, balance and record, but do not submit. */
  readonly dryRun?: boolean;
}

/** Outcome of a publication. */
export interface PublicationOutcome {
  readonly kind: "publication";
  readonly record: FinalizedPublication;
  readonly normalizedCost: Readonly<Record<string, number>>;
  readonly submittedId?: string;
  readonly inclusion?: IncludedTransaction;
  readonly merged?: boolean;
  readonly verified?: boolean;
}

/**
 * Publish a message: build one aggregate guaranteed-only transaction, prove, balance,
 * record the finalized public bytes, submit them once, wait for inclusion by
 * identifier, and verify the included transaction from its raw bytes.
 */
export const runPublish = async (
  services: ChainServices,
  options: PublishOptions,
): Promise<PublicationOutcome> => {
  const secret = readWitnessSecret(options.secretFile);
  try {
    const whitelist = options.profile.access === "whitelist";
    const contract = new options.generated.Contract(
      whitelist ? emitterWitnesses : messageOwnerWitnesses,
    );
    const emitPart = contract.impureCircuits.emitPart;
    if (emitPart === undefined) throw new CommandFailure("the contract has no emitPart circuit");
    const binding = bindingFromContract(
      { impureCircuits: { emitPart: emitPart as unknown as EmitPartCircuit<object> } },
      "emitPart",
      () => (whitelist ? { emitterSecret: secret } : { messageOwnerSecret: secret }),
    );
    const publication = encodePublication(options.message);
    const built = await buildPublicationTransaction(
      services.stateSource,
      binding,
      {
        network: services.network,
        emitter: options.address,
        coinPublicKey: services.coinPublicKey,
        maxParts: options.maxParts,
        ttlSeconds: options.ttlSeconds,
      },
      publication,
    );
    services.log(
      `built              ${String(publication.parts.length)} parts, request ${bytesToHex(publication.requestId)}, segment ${String(built.expected.segment)}, block ${String(built.block.height)}`,
    );
    const record = await finalizePublication(
      { prover: services.prover, balancer: services.balancer },
      built,
      {
        proofTimeoutMs: services.proofTimeoutMs,
        costCheck: blockFullnessCheck(options.maxBlockFraction ?? 1),
        requireProofs: services.requireProofs,
      },
    );
    const finalTx = deserializeTransaction(hexToBytes(record.transactionHex));
    const normalizedCost = {
      ...built.ledgerParameters.normalizeFullness(finalTx.cost(built.ledgerParameters, true)),
    };
    if (options.recordOut !== undefined)
      writeRecord(options.recordOut, { kind: "publication", record, normalizedCost });
    services.log(
      `finalized          ${String(record.transactionHex.length / 2)} bytes; block usage ${normalizedCost.blockUsage?.toFixed(4) ?? "?"} of a block`,
    );
    if (options.dryRun === true) return { kind: "publication", record, normalizedCost };
    const submittedId = await submitPublication(services.submitter, record, {
      requireProofs: services.requireProofs,
    });
    services.log(`submitted          ${submittedId}`);
    const inclusion = await services.waitForInclusion(
      record.identifiers,
      inclusionTimeout(built.ttl),
    );
    if (inclusion === undefined) {
      if (options.recordOut !== undefined) {
        writeRecord(options.recordOut, {
          kind: "publication",
          record,
          normalizedCost,
          submittedId,
        });
      }
      throw new CommandFailure(
        "the publication was not seen before its TTL; it was not included. Inspect public state; do not resubmit blindly",
      );
    }
    const included = deserializeTransaction(hexToBytes(inclusion.rawHex));
    const location = locatePublication(included, record);
    if (!location.contains) {
      throw new CommandFailure(
        `the included transaction does not contain the publication: ${location.reason ?? ""}`,
      );
    }
    const report = verifyPublicationTransaction(included, {
      emitter: options.address,
      entryPoint: "emitPart",
      network: services.network,
      status: inclusion.status,
      transactionHash: inclusion.hash,
    });
    const verified =
      report.issues.length === 0 &&
      report.accepted.some(
        (result) => result.message !== undefined && bytesEqual(result.message, options.message),
      );
    const outcome: PublicationOutcome = {
      kind: "publication",
      record,
      normalizedCost,
      submittedId,
      inclusion,
      merged: location.merged,
      verified,
    };
    if (options.recordOut !== undefined) writeRecord(options.recordOut, outcome);
    services.log(
      `included           ${inclusion.hash} at block ${String(inclusion.blockHeight)}, status ${inclusion.status}${location.merged ? " (merged by others)" : ""}; verified from raw bytes: ${verified ? "yes" : "NO"}`,
    );
    if (!verified) throw new CommandFailure(`verification failed: ${report.issues.join("; ")}`);
    return outcome;
  } finally {
    secret.fill(0);
  }
};
