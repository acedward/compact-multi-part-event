/**
 * Prove, balance, check and submit one publication without ever rebuilding it.
 *
 * The publication intent is re-checked before proving, after proving, after balancing
 * and after a serialization round trip; the finalized public bytes and identifiers are
 * the only thing persisted, and exactly those bytes are submitted. A publication is
 * tracked by its identifiers and its intent (segment and intent hash), because anyone
 * can merge further intents into it before inclusion, which changes the transaction
 * hash.
 *
 * @module
 */
import * as ledger from "@midnightntwrk/ledger-v9";

import { bytesToHex, hexToBytes } from "../codec/bytes.js";
import {
  type AnyTransaction,
  deserializeTransaction,
  transactionHashOf,
} from "../codec/raw-transaction.js";
import type { BuiltPublication } from "./compose.js";
import {
  assertPublicationIntent,
  type ExpectedPublication,
  PublicationCheckError,
} from "./guard.js";

/**
 * Proves every call of the unproven transaction (see `adapters/prover`).
 *
 * The seams are function-typed properties, not methods, so TypeScript checks their
 * parameters strictly: a provider with another payload shape (for example a
 * version-tagged `{ version, tx }` seam) does not type-check as this interface.
 */
export interface PublicationProver {
  readonly proveTx: (
    tx: ledger.UnprovenTransaction,
    config?: { readonly timeout?: number },
  ) => Promise<ledger.Transaction<ledger.SignatureEnabled, ledger.Proof, ledger.PreBinding>>;
}

/** Pays fees and binds (see `adapters/wallet`). */
export interface PublicationBalancer {
  readonly balanceTx: (
    tx: ledger.Transaction<ledger.SignatureEnabled, ledger.Proof, ledger.PreBinding>,
    ttl?: Date,
  ) => Promise<ledger.FinalizedTransaction>;
}

/** Submits a finalized transaction (see `adapters/wallet`). */
export interface PublicationSubmitter {
  readonly submitTx: (tx: ledger.FinalizedTransaction) => Promise<string>;
}

/**
 * Require a provider answer to be a live transaction of this process's ledger-v9
 * module, so a wrongly wired provider (serialized bytes, a version-tagged object, a
 * second ledger copy) fails at its stage with a clear message.
 */
const requireLedgerTransaction = (value: unknown, stage: string, provider: string): void => {
  if (!(value instanceof ledger.Transaction)) {
    const shape =
      value instanceof Uint8Array
        ? "serialized bytes"
        : typeof value === "object" && value !== null && "version" in value
          ? "a version-tagged payload"
          : typeof value;
    throw new PublicationCheckError(
      stage,
      `the ${provider} returned ${shape}, not a ledger-v9 transaction of this process; wrap the provider with an adapter`,
    );
  }
};

/** Hook that refuses a transaction whose cost does not fit the pinned parameters. */
export type CostCheck = (
  tx: AnyTransaction,
  params: ledger.LedgerParameters,
  stage: string,
) => void;

/**
 * Default cost check: the transaction's cost (time-to-dismiss enforced) must fit the
 * block limits of the pinned ledger parameters, with every normalized dimension at
 * most `maxFraction` of a block.
 */
export const blockFullnessCheck =
  (maxFraction = 1): CostCheck =>
  (tx, params, stage) => {
    let normalized: ledger.NormalizedCost;
    try {
      normalized = params.normalizeFullness(tx.cost(params, true));
    } catch (error) {
      throw new PublicationCheckError(
        stage,
        `cost exceeds the block limits: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    for (const [dimension, fraction] of Object.entries(normalized)) {
      if (fraction > maxFraction) {
        throw new PublicationCheckError(
          stage,
          `${dimension} uses ${fraction.toFixed(4)} of a block (limit ${String(maxFraction)})`,
        );
      }
    }
  };

/** The persisted, public record of a finalized publication (JSON-safe). */
export interface FinalizedPublication {
  readonly network: string;
  readonly emitter: string;
  readonly entryPoint: string;
  /** Physical segment of the publication intent. */
  readonly segment: number;
  readonly requestIdHex: string;
  readonly tailsHex: readonly string[];
  /** Finalized transaction bytes, hex. These exact bytes are submitted. */
  readonly transactionHex: string;
  /**
   * Ledger transaction hash of those bytes. `null` only for unproven stand-in
   * transactions (offline tests with `requireProofs: false`): ledger-v9 computes the
   * hash only for proven, signed and bound transactions.
   */
  readonly transactionHash: string | null;
  /** Every identifier of the finalized transaction; any may be watched. */
  readonly identifiers: readonly string[];
  /** Ledger intent hash of the publication intent at `segment`. */
  readonly intentHash: string;
  /** Intent TTL, ISO 8601. */
  readonly ttl: string;
  readonly blockHash: string;
  readonly blockHeight: number;
}

/** Options for {@link finalizePublication}. */
export interface FinalizeOptions {
  /** Per-request proof-server timeout, milliseconds. */
  readonly proofTimeoutMs: number;
  /** Cost hook run after proving and after balancing (default {@link blockFullnessCheck}). */
  readonly costCheck?: CostCheck;
  /**
   * Require the final bytes to be a proven and bound transaction (default true).
   * Offline tests with stand-in providers set it to false.
   */
  readonly requireProofs?: boolean;
}

const deserializeFinal = (bytes: Uint8Array, requireProofs: boolean): AnyTransaction => {
  if (!requireProofs) return deserializeTransaction(bytes);
  try {
    return ledger.Transaction.deserialize("signature", "proof", "binding", bytes);
  } catch (error) {
    throw new PublicationCheckError(
      "after serialization",
      `bytes are not a proven, bound transaction: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

const intentHashAt = (tx: AnyTransaction, segment: number, stage: string): string => {
  const intent = tx.intents?.get(segment);
  if (intent === undefined)
    throw new PublicationCheckError(stage, "publication intent disappeared");
  return intent.intentHash(segment);
};

/**
 * Prove once, balance once (passing the build TTL), and check the publication intent
 * after each stage and after a serialization round trip.
 *
 * @returns The public record to persist before submission.
 * @throws {PublicationCheckError | Error} Naming the failed stage.
 */
export const finalizePublication = async (
  providers: { readonly prover: PublicationProver; readonly balancer: PublicationBalancer },
  built: BuiltPublication,
  options: FinalizeOptions,
): Promise<FinalizedPublication> => {
  if (!Number.isSafeInteger(options.proofTimeoutMs) || options.proofTimeoutMs < 1) {
    throw new RangeError("proofTimeoutMs must be a positive safe integer");
  }
  const costCheck = options.costCheck ?? blockFullnessCheck();
  const requireProofs = options.requireProofs ?? true;
  const { expected, frozenTranscripts } = built;
  assertPublicationIntent(built.transaction, expected, "before proving", frozenTranscripts);
  const proven = await providers.prover.proveTx(built.transaction, {
    timeout: options.proofTimeoutMs,
  });
  requireLedgerTransaction(proven, "after proving", "prover");
  assertPublicationIntent(proven, expected, "after proving", frozenTranscripts);
  costCheck(proven, built.ledgerParameters, "after proving");
  const finalized = await providers.balancer.balanceTx(proven, built.ttl);
  requireLedgerTransaction(finalized, "after balancing", "balancer");
  assertPublicationIntent(finalized, expected, "after balancing", frozenTranscripts);
  costCheck(finalized, built.ledgerParameters, "after balancing");
  const bytes = finalized.serialize();
  const roundTrip = deserializeFinal(bytes, requireProofs);
  assertPublicationIntent(roundTrip, expected, "after serialization", frozenTranscripts);
  return {
    network: expected.network,
    emitter: expected.emitter,
    entryPoint: expected.entryPoint,
    segment: expected.segment,
    requestIdHex: bytesToHex(expected.requestId),
    tailsHex: expected.tails.map(bytesToHex),
    transactionHex: bytesToHex(bytes),
    transactionHash: transactionHashOf(roundTrip) ?? null,
    identifiers: roundTrip.identifiers(),
    intentHash: intentHashAt(roundTrip, expected.segment, "after serialization"),
    ttl: built.ttl.toISOString(),
    blockHash: built.block.hash,
    blockHeight: built.block.height,
  };
};

/** The expectation a persisted record encodes. */
export const expectedFromRecord = (record: FinalizedPublication): ExpectedPublication => ({
  network: record.network,
  emitter: record.emitter,
  entryPoint: record.entryPoint,
  segment: record.segment,
  requestId: hexToBytes(record.requestIdHex),
  tails: record.tailsHex.map(hexToBytes),
});

/**
 * Submit exactly the saved finalized bytes once, after re-checking them against the
 * record (publication intent, transaction hash, identifiers, intent hash).
 *
 * @returns The submitter's transaction identifier.
 * @throws {PublicationCheckError} If the saved bytes or the record were altered.
 */
export const submitPublication = async (
  submitter: PublicationSubmitter,
  record: FinalizedPublication,
  options: { readonly requireProofs?: boolean } = {},
): Promise<string> => {
  const stage = "before submission";
  const bytes = hexToBytes(record.transactionHex);
  const snapshot = deserializeFinal(bytes, options.requireProofs ?? true);
  assertPublicationIntent(snapshot, expectedFromRecord(record), stage);
  if ((transactionHashOf(snapshot) ?? null) !== record.transactionHash) {
    throw new PublicationCheckError(
      stage,
      "saved bytes do not match the recorded transaction hash",
    );
  }
  const identifiers = snapshot.identifiers();
  if (
    identifiers.length !== record.identifiers.length ||
    identifiers.some((identifier, index) => identifier !== record.identifiers[index])
  ) {
    throw new PublicationCheckError(stage, "saved bytes do not match the recorded identifiers");
  }
  if (intentHashAt(snapshot, record.segment, stage) !== record.intentHash) {
    throw new PublicationCheckError(stage, "saved bytes do not match the recorded intent hash");
  }
  return await submitter.submitTx(snapshot as ledger.FinalizedTransaction);
};

/** Where a (possibly merged) transaction stands relative to a publication record. */
export interface PublicationLocation {
  /** The transaction contains the publication's intent unchanged. */
  readonly contains: boolean;
  /** It does, and others merged intents into it (the hash differs). */
  readonly merged: boolean;
  readonly reason?: string;
}

/**
 * Decide whether a transaction (for example one found on chain by an identifier)
 * contains the recorded publication: every recorded identifier present, the intent at
 * the recorded segment unchanged (same intent hash) and passing the publication checks.
 */
export const locatePublication = (
  tx: AnyTransaction,
  record: FinalizedPublication,
): PublicationLocation => {
  const present = new Set(tx.identifiers());
  if (!record.identifiers.every((identifier) => present.has(identifier))) {
    return { contains: false, merged: false, reason: "a recorded identifier is missing" };
  }
  const intent = tx.intents?.get(record.segment);
  if (intent === undefined || intent.intentHash(record.segment) !== record.intentHash) {
    return { contains: false, merged: false, reason: "publication intent differs" };
  }
  try {
    assertPublicationIntent(tx, expectedFromRecord(record), "locate");
  } catch (error) {
    return {
      contains: false,
      merged: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  const hash = transactionHashOf(tx);
  const merged =
    hash !== undefined && record.transactionHash !== null
      ? hash !== record.transactionHash
      : tx.identifiers().length !== record.identifiers.length;
  return { contains: true, merged };
};
