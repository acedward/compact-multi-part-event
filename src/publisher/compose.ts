/**
 * Compose a transaction that holds one or several packages, one intent each.
 *
 * For each package the adopter's emitting circuit runs once per part, every part
 * against the same pinned block and contract state, and all of the package's calls go
 * into ONE intent through the ledger's `Transaction.addCalls({ tag: "guaranteedOnly" },
 * …)`. That is valid only because the emitting circuit writes nothing: its public
 * transcript is an access-control read of state no part changes, then the event.
 *
 * `addCalls` draws the intent's segment at random from the full 16-bit range: segment 0
 * is malformed, and a segment that already holds an intent would receive the calls too
 * (two packages in one intent). Both draws are redrawn.
 *
 * @module
 */
import { createHash } from "node:crypto";

import {
  type CallProofData,
  type CircuitContext,
  ContractState as RuntimeContractState,
  createCircuitContext,
} from "@midnight-ntwrk/compact-runtime";
import * as ledger from "@midnightntwrk/ledger-v9";

import { bytesEqual, bytesToHex } from "../reader/bytes.js";
import { eventName, eventValue } from "../reader/event.js";
import { decodeMiscValue } from "../reader/transaction.js";
import type { EmissionBinding } from "./binding.js";
import { assertTransactionPackages, type ExpectedPackage, PackageCheckError } from "./guard.js";
import { PART_LENGTH } from "./parts.js";

/** Default largest package, in parts. */
export const DEFAULT_MAX_PARTS = 8;
/**
 * Ceiling for the configurable part cap (an allocation bound). The real bound is the
 * block: the cost check after proving refuses a transaction that does not fit.
 */
export const MAX_PARTS_CEILING = 1024;
/** Largest number of packages in one transaction. */
export const MAX_PACKAGES = 16;
/** Default TTL after the pinned block's time. */
export const DEFAULT_TTL_SECONDS = 20 * 60;
/** Default upper bound for the TTL: the ledger's default global TTL (one hour). */
export const DEFAULT_MAX_TTL_SECONDS = 60 * 60;
/** Default number of draws per intent when the ledger picks segment 0 or a taken segment. */
export const DEFAULT_MAX_ASSEMBLY_ATTEMPTS = 8;

/** The block whose state and parameters a transaction is built on. */
export interface PinnedBlock {
  readonly hash: string;
  readonly height: number;
  /** Block time in seconds since the Unix epoch (the circuit clock unit). */
  readonly timestampSeconds: number;
}

/** Any contract state object that serializes to the ledger's contract-state bytes. */
export interface SerializableContractState {
  serialize(): Uint8Array;
}

/** Contract state and ledger parameters at one block. */
export interface ContractSnapshot {
  readonly contractState: SerializableContractState;
  readonly ledgerParameters: ledger.LedgerParameters;
}

/** Public data the publisher reads: one latest block, then states at that block. */
export interface PublicationStateSource {
  latestBlock(): Promise<PinnedBlock>;
  contractStateAt(address: string, blockHash: string): Promise<ContractSnapshot>;
}

/** Input to a key-location resolver. */
export interface KeyLocationInput {
  readonly address: string;
  readonly entryPoint: string;
  readonly verifierKey: Uint8Array;
}

/** Maps a call to the key location the proof provider resolves. */
export type KeyLocationResolver = (input: KeyLocationInput) => string;

/**
 * The canonical location grammar midnight-js 5 provers resolve:
 * `contract:<address>/<entryPoint>?vk=<sha256 of the deployed verifier key>`.
 */
export const canonicalKeyLocation: KeyLocationResolver = ({ address, entryPoint, verifierKey }) => {
  if (!/^[0-9a-f]{64}$/.test(address)) {
    throw new RangeError("key location: address must be 64 lowercase hex characters");
  }
  if (entryPoint.length === 0 || /[/?]/.test(entryPoint)) {
    throw new RangeError("key location: entry point must be non-empty without '/' or '?'");
  }
  const hash = createHash("sha256").update(verifierKey).digest("hex");
  return `contract:${address}/${entryPoint}?vk=${hash}`;
};

/** Publisher configuration, shared by every package of one transaction. */
export interface PublisherConfig {
  /** Ledger network id (for example `stagenet`). */
  readonly network: string;
  /** The submitting wallet's coin public key (the circuits' Zswap context). */
  readonly coinPublicKey: string;
  /** Largest package in parts (default 8, at most {@link MAX_PARTS_CEILING}). */
  readonly maxParts?: number;
  /** TTL after the pinned block time, in seconds (default 1200). */
  readonly ttlSeconds?: number;
  /** Upper bound for `ttlSeconds` (default 3600, the ledger's default global TTL). */
  readonly maxTtlSeconds?: number;
  /** Draws per intent when the ledger picks segment 0 or a taken segment (default 8). */
  readonly maxAssemblyAttempts?: number;
  /** Key-location resolver (default {@link canonicalKeyLocation}). */
  readonly keyLocation?: KeyLocationResolver;
}

/** One package to publish. */
export interface PackageRequest<PS> {
  /** The adopter's contract address, 64 lowercase hex characters. */
  readonly contract: string;
  /** The event name N the emitting circuit emits (text or 32 bytes). */
  readonly name: string | Uint8Array;
  /** The adopter's emitting circuit. */
  readonly binding: EmissionBinding<PS>;
  /** The parts in order, each exactly 256 bytes (see `splitPayload`). */
  readonly parts: readonly Uint8Array[];
}

/** An assembled, unproven transaction (in memory only: it holds proof inputs). */
export interface BuiltTransaction {
  readonly transaction: ledger.UnprovenTransaction;
  /** One expectation per package, in request order. */
  readonly packages: readonly ExpectedPackage[];
  /** Guaranteed transcripts per package, frozen right after assembly (in-memory only). */
  readonly frozenTranscripts: readonly (readonly ledger.Transcript<ledger.AlignedValue>[])[];
  readonly block: PinnedBlock;
  readonly ledgerParameters: ledger.LedgerParameters;
  readonly ttl: Date;
  /** Draws per package (more than one when segment 0 or a taken segment was drawn). */
  readonly assemblyAttempts: readonly number[];
}

interface ResolvedConfig {
  readonly network: string;
  readonly coinPublicKey: string;
  readonly maxParts: number;
  readonly ttlSeconds: number;
  readonly maxAssemblyAttempts: number;
  readonly keyLocation: KeyLocationResolver;
}

const positiveInteger = (value: number, name: string, max = Number.MAX_SAFE_INTEGER): number => {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new RangeError(`${name} must be an integer from 1 through ${String(max)}`);
  }
  return value;
};

/**
 * Validate and complete a publisher configuration.
 *
 * @throws {RangeError} On any invalid field.
 */
export const resolvePublisherConfig = (config: PublisherConfig): ResolvedConfig => {
  if (config.network.length === 0) throw new RangeError("network must be non-empty");
  if (config.coinPublicKey.length === 0) throw new RangeError("coinPublicKey must be non-empty");
  const maxTtlSeconds = positiveInteger(
    config.maxTtlSeconds ?? DEFAULT_MAX_TTL_SECONDS,
    "maxTtlSeconds",
  );
  return {
    network: config.network,
    coinPublicKey: config.coinPublicKey,
    maxParts: positiveInteger(config.maxParts ?? DEFAULT_MAX_PARTS, "maxParts", MAX_PARTS_CEILING),
    ttlSeconds: positiveInteger(
      config.ttlSeconds ?? DEFAULT_TTL_SECONDS,
      "ttlSeconds",
      maxTtlSeconds,
    ),
    maxAssemblyAttempts: positiveInteger(
      config.maxAssemblyAttempts ?? DEFAULT_MAX_ASSEMBLY_ATTEMPTS,
      "maxAssemblyAttempts",
      64,
    ),
    keyLocation: config.keyLocation ?? canonicalKeyLocation,
  };
};

/**
 * Reject a package request before any state query.
 *
 * @throws {RangeError} Naming the violated rule.
 */
export const preflightPackage = (
  request: PackageRequest<unknown>,
  maxParts: number,
  label = "package",
): Uint8Array => {
  if (!/^[0-9a-f]{64}$/.test(request.contract)) {
    throw new RangeError(`${label}: contract must be 64 lowercase hex characters`);
  }
  if (request.binding.entryPoint.length === 0) {
    throw new RangeError(`${label}: the binding has no entry point`);
  }
  const name = eventName(request.name);
  const count = request.parts.length;
  if (count < 1 || count > maxParts) {
    throw new RangeError(
      `${label} has ${String(count)} parts; the configured limit is 1..${String(maxParts)}`,
    );
  }
  request.parts.forEach((part, index) => {
    if (part.byteLength !== PART_LENGTH) {
      throw new RangeError(
        `${label}: part ${String(index + 1)} is ${String(part.byteLength)} bytes, not 256`,
      );
    }
  });
  return name;
};

/** The ledger query context a call's pre-transcript starts from (with its commitments). */
export const ledgerQueryContext = (trace: CallProofData): ledger.QueryContext => {
  const state = ledger.StateValue.decode(trace.initialQueryContext.state.state.encode());
  let context = new ledger.QueryContext(
    new ledger.ChargedState(state),
    trace.initialQueryContext.address,
  );
  context.block = trace.initialQueryContext.block;
  context.effects = trace.initialQueryContext.effects;
  for (const [commitment, index] of trace.finalQueryContext.comIndices) {
    context = context.insertCommitment(commitment, index);
  }
  return context;
};

/**
 * The native pre-partition call for one executed circuit call.
 *
 * @throws {Error} If the contract state has no operation for the circuit.
 */
export const prePartitionCallFor = (
  trace: CallProofData,
  contractState: ledger.ContractState,
  keyLocation: string,
): ledger.PrePartitionContractCall => {
  const operation = contractState.operation(trace.circuitId);
  if (operation === undefined) throw new Error(`no operation '${trace.circuitId}'`);
  return new ledger.PrePartitionContractCall(
    trace.contractAddress,
    trace.circuitId,
    operation,
    new ledger.PreTranscript(ledgerQueryContext(trace), trace.publicTranscript),
    trace.privateTranscriptOutputs,
    trace.input,
    trace.output,
    ledger.communicationCommitmentRandomness(),
    keyLocation,
  );
};

/**
 * Add one intent of guaranteed-only calls to a transaction through
 * `addCalls({ tag: "guaranteedOnly" }, …)`, redrawing while the ledger picks segment 0 or
 * a segment that already holds an intent.
 *
 * @param calls - Builds the calls for one attempt (fresh commitment randomness each time).
 * @throws {Error} If every attempt draws segment 0 or a taken segment.
 */
export const addGuaranteedIntent = (
  tx: ledger.UnprovenTransaction,
  calls: () => ledger.PrePartitionContractCall[],
  ledgerParameters: ledger.LedgerParameters,
  ttl: Date,
  maxAttempts: number,
): {
  readonly transaction: ledger.UnprovenTransaction;
  readonly segment: number;
  readonly attempts: number;
} => {
  const before = new Set(tx.intents?.keys() ?? []);
  for (let attempts = 1; attempts <= maxAttempts; attempts += 1) {
    const next = tx.addCalls({ tag: "guaranteedOnly" }, calls(), ledgerParameters, ttl);
    const added = [...(next.intents?.keys() ?? [])].filter((segment) => !before.has(segment));
    const [segment] = added;
    if (added.length === 1 && segment !== undefined && segment !== 0) {
      return { transaction: next, segment, attempts };
    }
  }
  throw new Error(
    `assembly drew segment 0 or a taken segment in all ${String(maxAttempts)} attempts`,
  );
};

const checkExecution = (
  trace: CallProofData | undefined,
  traces: number,
  events: readonly { address: string; eventType: string; data: unknown }[],
  expectedValue: Uint8Array,
  contract: string,
  entryPoint: string,
  label: string,
): CallProofData => {
  const fail = (detail: string): never => {
    throw new PackageCheckError("execution", `${label}: ${detail}`);
  };
  if (traces !== 1 || trace === undefined) {
    return fail(`produced ${String(traces)} call traces, expected 1`);
  }
  if (trace.contractAddress !== contract || trace.circuitId !== entryPoint) {
    fail("trace targets another contract or circuit");
  }
  if (trace.commCommData !== undefined) fail("the emission made a cross-contract call");
  const zswap = trace.zswapLocalState as {
    inputs?: readonly unknown[];
    outputs?: readonly unknown[];
  };
  if ((zswap.inputs?.length ?? 0) > 0 || (zswap.outputs?.length ?? 0) > 0) {
    fail("the emission touched shielded coins");
  }
  if (events.length !== 1) fail(`emitted ${String(events.length)} events, expected 1`);
  const [event] = events;
  if (event === undefined || event.address !== contract || event.eventType !== "misc") {
    return fail("did not emit one Misc event from the contract");
  }
  let value: Uint8Array;
  try {
    value = decodeMiscValue(event.data as ledger.EncodedStateValue);
  } catch (error) {
    return fail(`event value: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!bytesEqual(value, expectedValue))
    fail("emitted bytes differ from the part (name or payload)");
  return trace;
};

/**
 * Build the unproven transaction holding the given packages, one intent each.
 *
 * Order: validate config and every request (no provider access) → read one latest block
 * → read each contract's state and the ledger parameters at that block → execute every
 * part from its contract's pinned state with the block time in seconds → one
 * `addCalls({ tag: "guaranteedOnly" })` intent per package (redrawn on segment 0 or a
 * taken segment) → check every package's intent.
 *
 * @throws {RangeError | PackageCheckError | Error} Before any proof exists.
 */
export const buildPackagesTransaction = async (
  source: PublicationStateSource,
  config: PublisherConfig,
  requests: readonly PackageRequest<unknown>[],
): Promise<BuiltTransaction> => {
  const resolved = resolvePublisherConfig(config);
  if (requests.length < 1 || requests.length > MAX_PACKAGES) {
    throw new RangeError(`a transaction holds 1..${String(MAX_PACKAGES)} packages`);
  }
  const names = requests.map((request, index) =>
    preflightPackage(
      request,
      resolved.maxParts,
      requests.length === 1 ? "package" : `package ${String(index + 1)}`,
    ),
  );
  const block = await source.latestBlock();
  if (block.hash.length === 0) throw new Error("latest block has no hash");
  if (!Number.isSafeInteger(block.timestampSeconds) || block.timestampSeconds < 1) {
    throw new RangeError("block time must be a positive integer number of seconds");
  }
  const snapshots = new Map<string, ContractSnapshot>();
  for (const request of requests) {
    if (!snapshots.has(request.contract)) {
      snapshots.set(request.contract, await source.contractStateAt(request.contract, block.hash));
    }
  }
  const [first] = snapshots.values();
  if (first === undefined) throw new Error("no contract state");
  const ledgerParameters = first.ledgerParameters;
  const ttl = new Date((block.timestampSeconds + resolved.ttlSeconds) * 1000);

  let transaction = ledger.Transaction.fromPartsRandomized(resolved.network);
  const packages: ExpectedPackage[] = [];
  const attempts: number[] = [];
  for (const [index, request] of requests.entries()) {
    const label = requests.length === 1 ? "part" : `package ${String(index + 1)} part`;
    const name = names[index] ?? eventName(request.name);
    const snapshot = snapshots.get(request.contract);
    if (snapshot === undefined) throw new Error("missing snapshot");
    const stateBytes = snapshot.contractState.serialize();
    const runtimeState = RuntimeContractState.deserialize(stateBytes);
    const ledgerState = ledger.ContractState.deserialize(stateBytes);
    const entryPoint = request.binding.entryPoint;
    const verifierKey = ledgerState.operation(entryPoint)?.verifierKey;
    if (verifierKey === undefined || verifierKey.byteLength === 0) {
      throw new Error(`contract ${request.contract} has no verifier key for '${entryPoint}'`);
    }
    const keyLocation = resolved.keyLocation({
      address: request.contract,
      entryPoint,
      verifierKey,
    });
    const traces: CallProofData[] = [];
    for (const [partIndex, part] of request.parts.entries()) {
      const context: CircuitContext<unknown> = createCircuitContext(
        entryPoint,
        request.contract,
        resolved.coinPublicKey,
        runtimeState,
        request.binding.createPrivateState(),
        undefined,
        undefined,
        undefined,
        block.timestampSeconds,
        block.hash,
      );
      const result = await request.binding.emitPart(context, part);
      traces.push(
        checkExecution(
          result.context.callProofDataTrace[0],
          result.context.callProofDataTrace.length,
          result.context.events,
          eventValue(name, part),
          request.contract,
          entryPoint,
          `${label} ${String(partIndex + 1)}`,
        ),
      );
    }
    const added = addGuaranteedIntent(
      transaction,
      () => traces.map((trace) => prePartitionCallFor(trace, ledgerState, keyLocation)),
      ledgerParameters,
      ttl,
      resolved.maxAssemblyAttempts,
    );
    transaction = added.transaction;
    attempts.push(added.attempts);
    packages.push({
      network: resolved.network,
      contract: request.contract,
      entryPoint,
      name,
      segment: added.segment,
      parts: request.parts.map((part) => Uint8Array.from(part)),
    });
  }
  assertTransactionPackages(transaction, packages, "after assembly");
  const frozenTranscripts = packages.map((pkg) =>
    (transaction.intents?.get(pkg.segment)?.actions ?? []).map((action) => {
      if (!(action instanceof ledger.ContractCall) || action.guaranteedTranscript === undefined) {
        throw new PackageCheckError("after assembly", "a call lost its guaranteed transcript");
      }
      return action.guaranteedTranscript;
    }),
  );
  return {
    transaction,
    packages,
    frozenTranscripts,
    block,
    ledgerParameters,
    ttl,
    assemblyAttempts: attempts,
  };
};

/**
 * Build the unproven transaction for one package (see {@link buildPackagesTransaction}).
 */
export const buildPackageTransaction = <PS>(
  source: PublicationStateSource,
  config: PublisherConfig,
  request: PackageRequest<PS>,
): Promise<BuiltTransaction> => buildPackagesTransaction(source, config, [request]);

/** Hex of a package's name, for logs and records. */
export const nameHex = (pkg: ExpectedPackage): string => bytesToHex(pkg.name);
