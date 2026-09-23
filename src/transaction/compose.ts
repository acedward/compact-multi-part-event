/**
 * Compose one publication transaction: every part is executed from one pinned public
 * state through the injected binding, and all calls are partitioned together by the
 * ledger's aggregate `Transaction.addCalls({ tag: "guaranteedOnly" }, …)`.
 *
 * Executing each part from the same pre-state is valid only because the emission
 * circuit's public transcript is an access-control read of state the publication does
 * not change, followed by the event. A circuit that writes state, or reads state
 * another transaction can change before inclusion, is outside this pattern.
 *
 * @module
 */
import { createHash } from "node:crypto";

import {
  type CallProofData,
  ContractState as RuntimeContractState,
  createCircuitContext,
} from "@midnight-ntwrk/compact-runtime";
import * as ledger from "@midnightntwrk/ledger-v9";

import { bytesEqual, bytesToHex } from "../codec/bytes.js";
import { FORMAT_MAX_PARTS, PART_DATA_LENGTH, TAIL_LENGTH } from "../codec/constants.js";
import { decodeMiscValue } from "../codec/raw-transaction.js";
import { type PublicEvent, readPublications, ReadStatus } from "../codec/reader.js";
import {
  eventNameFor,
  eventPayloadFor,
  eventValueFor,
  type EncodedPublication,
} from "../codec/writer.js";
import type { EmissionBinding } from "./binding.js";
import {
  assertPublicationIntent,
  type ExpectedPublication,
  PublicationCheckError,
} from "./guard.js";

/** Default largest publication, in parts (1,664 message bytes). */
export const DEFAULT_MAX_PARTS = 8;
/** Default TTL after the pinned block's time. */
export const DEFAULT_TTL_SECONDS = 20 * 60;
/** Default upper bound for the TTL: the ledger's default global TTL (one hour). */
export const DEFAULT_MAX_TTL_SECONDS = 60 * 60;
/** Default number of assembly attempts when the ledger picks segment 0. */
export const DEFAULT_MAX_ASSEMBLY_ATTEMPTS = 8;

/** The block whose state and parameters a publication is built on. */
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

/** Public data the composer reads: one latest block, then one state at that block. */
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

/** Composer configuration. */
export interface PublicationConfig {
  /** Ledger network id (for example `stagenet`). */
  readonly network: string;
  /** Emitter contract address, 64 lowercase hex characters. */
  readonly emitter: string;
  /** The submitting wallet's coin public key (the circuits' Zswap context). */
  readonly coinPublicKey: string;
  /** Largest publication in parts (1..999; default 8). */
  readonly maxParts?: number;
  /** Largest message in bytes (default `maxParts * 208`). */
  readonly maxMessageBytes?: number;
  /** TTL after the pinned block time, in seconds (default 1200). */
  readonly ttlSeconds?: number;
  /** Upper bound for `ttlSeconds` (default 3600, the ledger's default global TTL). */
  readonly maxTtlSeconds?: number;
  /** Attempts when the ledger picks segment 0 (default 8). */
  readonly maxAssemblyAttempts?: number;
  /** Key-location resolver (default {@link canonicalKeyLocation}). */
  readonly keyLocation?: KeyLocationResolver;
}

/** An assembled, unproven publication (in memory only: it holds proof inputs). */
export interface BuiltPublication {
  readonly transaction: ledger.UnprovenTransaction;
  readonly expected: ExpectedPublication;
  /** Guaranteed transcripts frozen right after assembly (in-memory comparisons only). */
  readonly frozenTranscripts: readonly ledger.Transcript<ledger.AlignedValue>[];
  readonly block: PinnedBlock;
  readonly ledgerParameters: ledger.LedgerParameters;
  readonly ttl: Date;
  /** Number of `addCalls` attempts (more than one when segment 0 was drawn). */
  readonly assemblyAttempts: number;
}

interface ResolvedConfig {
  readonly network: string;
  readonly emitter: string;
  readonly coinPublicKey: string;
  readonly maxParts: number;
  readonly maxMessageBytes: number;
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
 * Validate and complete a composer configuration.
 *
 * @throws {RangeError} On any invalid field.
 */
export const resolvePublicationConfig = (config: PublicationConfig): ResolvedConfig => {
  if (config.network.length === 0) throw new RangeError("network must be non-empty");
  if (!/^[0-9a-f]{64}$/.test(config.emitter)) {
    throw new RangeError("emitter must be 64 lowercase hex characters");
  }
  if (config.coinPublicKey.length === 0) throw new RangeError("coinPublicKey must be non-empty");
  const maxParts = positiveInteger(
    config.maxParts ?? DEFAULT_MAX_PARTS,
    "maxParts",
    FORMAT_MAX_PARTS,
  );
  const maxMessageBytes = positiveInteger(
    config.maxMessageBytes ?? maxParts * PART_DATA_LENGTH,
    "maxMessageBytes",
    maxParts * PART_DATA_LENGTH,
  );
  const maxTtlSeconds = positiveInteger(
    config.maxTtlSeconds ?? DEFAULT_MAX_TTL_SECONDS,
    "maxTtlSeconds",
  );
  const ttlSeconds = positiveInteger(
    config.ttlSeconds ?? DEFAULT_TTL_SECONDS,
    "ttlSeconds",
    maxTtlSeconds,
  );
  const maxAssemblyAttempts = positiveInteger(
    config.maxAssemblyAttempts ?? DEFAULT_MAX_ASSEMBLY_ATTEMPTS,
    "maxAssemblyAttempts",
    64,
  );
  return {
    network: config.network,
    emitter: config.emitter,
    coinPublicKey: config.coinPublicKey,
    maxParts,
    maxMessageBytes,
    ttlSeconds,
    maxAssemblyAttempts,
    keyLocation: config.keyLocation ?? canonicalKeyLocation,
  };
};

/**
 * Reject a publication that is not complete and canonical, before any state query,
 * using the independent reader (never the writer).
 *
 * @throws {RangeError} Naming the violated rule.
 */
export const preflightPublication = (
  publication: EncodedPublication,
  limits: { readonly maxParts: number; readonly maxMessageBytes: number },
): void => {
  const count = publication.parts.length;
  if (count < 1 || count > limits.maxParts) {
    throw new RangeError(
      `publication has ${String(count)} parts; the configured limit is ${String(limits.maxParts)}`,
    );
  }
  if (publication.messageLength > limits.maxMessageBytes) {
    throw new RangeError(
      `message length ${String(publication.messageLength)} exceeds ${String(limits.maxMessageBytes)}`,
    );
  }
  const events: PublicEvent[] = publication.parts.map((part, index) => {
    if (
      part.tail.byteLength !== TAIL_LENGTH ||
      part.position !== index + 1 ||
      part.total !== count
    ) {
      throw new RangeError(
        `part at index ${String(index)} is not part ${String(index + 1)} of ${String(count)}`,
      );
    }
    return {
      network: "preflight",
      emitter: "preflight",
      transactionId: "preflight",
      eventId: String(index + 1),
      name: eventNameFor(part.tail),
      payload: eventPayloadFor(publication.requestId, part.tail),
    };
  });
  const { results } = readPublications(events, {
    limits: {
      maxParts: limits.maxParts,
      maxMessageBytes: limits.maxMessageBytes,
      maxEvents: count,
      maxGroups: 1,
    },
  });
  const [result] = results;
  if (
    results.length !== 1 ||
    result?.status !== ReadStatus.Complete ||
    result.message === undefined
  ) {
    throw new RangeError(
      `publication is not complete and canonical: ${results.flatMap((entry) => entry.issues).join("; ")}`,
    );
  }
  if (result.message.byteLength !== publication.messageLength) {
    throw new RangeError("publication message length disagrees with its parts");
  }
};

/**
 * Retry an assembly until the ledger picks a non-zero segment. `addCalls` draws the
 * guaranteed-only segment from the full 16-bit range and segment 0 is malformed.
 *
 * @throws {Error} If every attempt lands on segment 0.
 */
export const retryUntilNonZeroSegment = <T>(
  assemble: () => T,
  segmentOf: (value: T) => number,
  maxAttempts: number,
): { readonly value: T; readonly segment: number; readonly attempts: number } => {
  for (let attempts = 1; attempts <= maxAttempts; attempts += 1) {
    const value = assemble();
    const segment = segmentOf(value);
    if (segment !== 0) return { value, segment, attempts };
  }
  throw new Error(`assembly drew segment 0 in all ${String(maxAttempts)} attempts`);
};

const singleSegment = (tx: ledger.UnprovenTransaction): number => {
  const segments = [...(tx.intents?.keys() ?? [])];
  const [segment] = segments;
  if (segments.length !== 1 || segment === undefined) {
    throw new Error(`aggregate assembly produced ${String(segments.length)} intents, expected 1`);
  }
  return segment;
};

const ledgerQueryContext = (trace: CallProofData): ledger.QueryContext => {
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

const checkExecution = (
  trace: CallProofData | undefined,
  traces: number,
  events: readonly { address: string; eventType: string; data: unknown }[],
  expectedValue: Uint8Array,
  config: ResolvedConfig,
  entryPoint: string,
  part: number,
): CallProofData => {
  const fail = (detail: string): never => {
    throw new PublicationCheckError("execution", `part ${String(part)}: ${detail}`);
  };
  if (traces !== 1 || trace === undefined)
    return fail(`produced ${String(traces)} call traces, expected 1`);
  if (trace.contractAddress !== config.emitter || trace.circuitId !== entryPoint) {
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
  if (event === undefined || event.address !== config.emitter || event.eventType !== "misc") {
    return fail("did not emit one Misc event from the emitter");
  }
  let value: Uint8Array;
  try {
    value = decodeMiscValue(event.data as ledger.EncodedStateValue);
  } catch (error) {
    return fail(`event value: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!bytesEqual(value, expectedValue)) fail("emitted bytes differ from the part");
  return trace;
};

/**
 * Build the unproven publication transaction.
 *
 * Order: validate config and publication (no provider access) → read one latest block
 * → read the emitter's state and ledger parameters at that block → execute every part
 * from that state with the block time in seconds → one aggregate guaranteed-only
 * `addCalls` (rebuilt if segment 0 is drawn) → check the publication intent.
 *
 * @throws {RangeError | PublicationCheckError | Error} Before any proof exists.
 */
export const buildPublicationTransaction = async <PS>(
  source: PublicationStateSource,
  binding: EmissionBinding<PS>,
  config: PublicationConfig,
  publication: EncodedPublication,
): Promise<BuiltPublication> => {
  const resolved = resolvePublicationConfig(config);
  preflightPublication(publication, resolved);
  const block = await source.latestBlock();
  if (block.hash.length === 0) throw new Error("latest block has no hash");
  if (!Number.isSafeInteger(block.timestampSeconds) || block.timestampSeconds < 1) {
    throw new RangeError("block time must be a positive integer number of seconds");
  }
  const snapshot = await source.contractStateAt(resolved.emitter, block.hash);
  const stateBytes = snapshot.contractState.serialize();
  const runtimeState = RuntimeContractState.deserialize(stateBytes);
  const ledgerState = ledger.ContractState.deserialize(stateBytes);
  const verifierKey = ledgerState.operation(binding.entryPoint)?.verifierKey;
  if (verifierKey === undefined || verifierKey.byteLength === 0) {
    throw new Error(`emitter has no verifier key for '${binding.entryPoint}'`);
  }
  const keyLocation = resolved.keyLocation({
    address: resolved.emitter,
    entryPoint: binding.entryPoint,
    verifierKey,
  });

  const traces: CallProofData[] = [];
  for (const part of publication.parts) {
    const context = createCircuitContext(
      binding.entryPoint,
      resolved.emitter,
      resolved.coinPublicKey,
      runtimeState,
      binding.createPrivateState(),
      undefined,
      undefined,
      undefined,
      block.timestampSeconds,
      block.hash,
    );
    const result = await binding.emitPart(context, publication.requestId, part.tail);
    traces.push(
      checkExecution(
        result.context.callProofDataTrace[0],
        result.context.callProofDataTrace.length,
        result.context.events,
        eventValueFor(publication.requestId, part.tail),
        resolved,
        binding.entryPoint,
        part.position,
      ),
    );
  }

  const ttl = new Date((block.timestampSeconds + resolved.ttlSeconds) * 1000);
  const assembled = retryUntilNonZeroSegment(
    () => {
      const calls = traces.map((trace) => {
        const operation = ledgerState.operation(trace.circuitId);
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
      });
      return ledger.Transaction.fromPartsRandomized(resolved.network).addCalls(
        { tag: "guaranteedOnly" },
        calls,
        snapshot.ledgerParameters,
        ttl,
      );
    },
    singleSegment,
    resolved.maxAssemblyAttempts,
  );
  const expected: ExpectedPublication = {
    network: resolved.network,
    emitter: resolved.emitter,
    entryPoint: binding.entryPoint,
    segment: assembled.segment,
    requestId: publication.requestId,
    tails: publication.parts.map((part) => part.tail),
  };
  assertPublicationIntent(assembled.value, expected, "after assembly");
  const intent = assembled.value.intents?.get(assembled.segment);
  const frozenTranscripts = (intent?.actions ?? []).map((action) => {
    if (!(action instanceof ledger.ContractCall) || action.guaranteedTranscript === undefined) {
      throw new PublicationCheckError("after assembly", "call lost its guaranteed transcript");
    }
    return action.guaranteedTranscript;
  });
  return {
    transaction: assembled.value,
    expected,
    frozenTranscripts,
    block,
    ledgerParameters: snapshot.ledgerParameters,
    ttl,
    assemblyAttempts: assembled.attempts,
  };
};

/** Hex of the request ID, for logs and records. */
export const requestIdHex = (built: BuiltPublication): string =>
  bytesToHex(built.expected.requestId);
