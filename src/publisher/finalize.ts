/**
 * Prove, balance, check and submit a built transaction without ever rebuilding it.
 *
 * Every package's intent is re-checked before proving, after proving, after balancing
 * and after a serialization round trip; the finalized public bytes and identifiers are
 * the only thing persisted, and exactly those bytes are submitted once. A package is
 * tracked by the transaction's identifiers and its intent (segment and intent hash):
 * anyone can merge further intents into the transaction before inclusion, which changes
 * the transaction hash but never the segment or the intent.
 *
 * @module
 */
import * as ledger from "@midnightntwrk/ledger-v9";

import { bytesToHex, hexToBytes } from "../reader/bytes.js";
import {
  type AnyTransaction,
  deserializeTransaction,
  transactionHashOf,
} from "../reader/transaction.js";
import type { BuiltTransaction } from "./compose.js";
import { assertTransactionPackages, type ExpectedPackage, PackageCheckError } from "./guard.js";

/**
 * Proves every call of the unproven transaction.
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

/** Pays fees and binds (the adopter's wallet). */
export interface PublicationBalancer {
  readonly balanceTx: (
    tx: ledger.Transaction<ledger.SignatureEnabled, ledger.Proof, ledger.PreBinding>,
    ttl?: Date,
  ) => Promise<ledger.FinalizedTransaction>;
}

/** Submits a finalized transaction (the adopter's wallet or node client). */
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
    throw new PackageCheckError(
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
      throw new PackageCheckError(
        stage,
        `cost exceeds the block limits: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    for (const [dimension, fraction] of Object.entries(normalized)) {
      if (fraction > maxFraction) {
        throw new PackageCheckError(
          stage,
          `${dimension} uses ${fraction.toFixed(4)} of a block (limit ${String(maxFraction)})`,
        );
      }
    }
  };

/** The public record of one package in a finalized transaction (JSON-safe). */
export interface PackageRecord {
  readonly contract: string;
  readonly entryPoint: string;
  /** The event name N, 32 bytes as hex. */
  readonly nameHex: string;
  /** Physical segment of the package's intent. */
  readonly segment: number;
  /** The parts in order, hex. */
  readonly partsHex: readonly string[];
  /** Ledger intent hash of the package's intent. */
  readonly intentHash: string;
}

/** The persisted, public record of a finalized transaction (JSON-safe). */
export interface FinalizedRecord {
  readonly network: string;
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
  readonly packages: readonly PackageRecord[];
  /** Intent TTL, ISO 8601. */
  readonly ttl: string;
  readonly blockHash: string;
  readonly blockHeight: number;
}

/** Options for {@link finalizeTransactionPackages}. */
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

/** Deserialize saved final bytes, requiring a proven, bound transaction unless told otherwise. */
export const deserializeFinal = (
  bytes: Uint8Array,
  requireProofs: boolean,
  stage = "after serialization",
): AnyTransaction => {
  if (!requireProofs) return deserializeTransaction(bytes);
  try {
    return ledger.Transaction.deserialize("signature", "proof", "binding", bytes);
  } catch (error) {
    throw new PackageCheckError(
      stage,
      `bytes are not a proven, bound transaction: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

const intentHashAt = (tx: AnyTransaction, segment: number, stage: string): string => {
  const intent = tx.intents?.get(segment);
  if (intent === undefined) throw new PackageCheckError(stage, "a package intent disappeared");
  return intent.intentHash(segment);
};

/**
 * Prove once, balance once (passing the build TTL), and check every package's intent
 * after each stage and after a serialization round trip.
 *
 * @returns The public record to persist before submission.
 * @throws {PackageCheckError | Error} Naming the failed stage.
 */
export const finalizeTransactionPackages = async (
  providers: { readonly prover: PublicationProver; readonly balancer: PublicationBalancer },
  built: BuiltTransaction,
  options: FinalizeOptions,
): Promise<FinalizedRecord> => {
  if (!Number.isSafeInteger(options.proofTimeoutMs) || options.proofTimeoutMs < 1) {
    throw new RangeError("proofTimeoutMs must be a positive safe integer");
  }
  const costCheck = options.costCheck ?? blockFullnessCheck();
  const requireProofs = options.requireProofs ?? true;
  const { packages, frozenTranscripts } = built;
  assertTransactionPackages(built.transaction, packages, "before proving", frozenTranscripts);
  const proven = await providers.prover.proveTx(built.transaction, {
    timeout: options.proofTimeoutMs,
  });
  requireLedgerTransaction(proven, "after proving", "prover");
  assertTransactionPackages(proven, packages, "after proving", frozenTranscripts);
  costCheck(proven, built.ledgerParameters, "after proving");
  const finalized = await providers.balancer.balanceTx(proven, built.ttl);
  requireLedgerTransaction(finalized, "after balancing", "balancer");
  assertTransactionPackages(finalized, packages, "after balancing", frozenTranscripts);
  costCheck(finalized, built.ledgerParameters, "after balancing");
  const bytes = finalized.serialize();
  const roundTrip = deserializeFinal(bytes, requireProofs);
  assertTransactionPackages(roundTrip, packages, "after serialization", frozenTranscripts);
  return {
    network: packages[0]?.network ?? "",
    transactionHex: bytesToHex(bytes),
    transactionHash: transactionHashOf(roundTrip) ?? null,
    identifiers: roundTrip.identifiers(),
    packages: packages.map((pkg) => ({
      contract: pkg.contract,
      entryPoint: pkg.entryPoint,
      nameHex: bytesToHex(pkg.name),
      segment: pkg.segment,
      partsHex: pkg.parts.map(bytesToHex),
      intentHash: intentHashAt(roundTrip, pkg.segment, "after serialization"),
    })),
    ttl: built.ttl.toISOString(),
    blockHash: built.block.hash,
    blockHeight: built.block.height,
  };
};

/** The expectations a persisted record encodes, one per package. */
export const expectedFromRecord = (record: FinalizedRecord): ExpectedPackage[] =>
  record.packages.map((pkg) => ({
    network: record.network,
    contract: pkg.contract,
    entryPoint: pkg.entryPoint,
    name: hexToBytes(pkg.nameHex),
    segment: pkg.segment,
    parts: pkg.partsHex.map(hexToBytes),
  }));

/**
 * Submit exactly the saved finalized bytes once, after re-checking them against the
 * record (every package intent and its intent hash, the transaction hash, the
 * identifiers).
 *
 * @returns The submitter's transaction identifier.
 * @throws {PackageCheckError} If the saved bytes or the record were altered.
 */
export const submitRecord = async (
  submitter: PublicationSubmitter,
  record: FinalizedRecord,
  options: { readonly requireProofs?: boolean } = {},
): Promise<string> => {
  const stage = "before submission";
  const snapshot = deserializeFinal(
    hexToBytes(record.transactionHex),
    options.requireProofs ?? true,
    stage,
  );
  assertTransactionPackages(snapshot, expectedFromRecord(record), stage);
  if ((transactionHashOf(snapshot) ?? null) !== record.transactionHash) {
    throw new PackageCheckError(stage, "saved bytes do not match the recorded transaction hash");
  }
  const identifiers = snapshot.identifiers();
  if (
    identifiers.length !== record.identifiers.length ||
    identifiers.some((identifier, index) => identifier !== record.identifiers[index])
  ) {
    throw new PackageCheckError(stage, "saved bytes do not match the recorded identifiers");
  }
  for (const pkg of record.packages) {
    if (intentHashAt(snapshot, pkg.segment, stage) !== pkg.intentHash) {
      throw new PackageCheckError(stage, "saved bytes do not match a recorded intent hash");
    }
  }
  return await submitter.submitTx(snapshot as ledger.FinalizedTransaction);
};

/** Where a (possibly merged) transaction stands relative to a record. */
export interface RecordLocation {
  /** The transaction contains every recorded package's intent unchanged. */
  readonly contains: boolean;
  /** It does, and others merged intents into it (the hash differs). */
  readonly merged: boolean;
  readonly reason?: string;
}

/**
 * Decide whether a transaction (for example one found on chain by an identifier)
 * contains the recorded packages: every recorded identifier present, and every package
 * intent at its recorded segment unchanged (same intent hash) and passing the package
 * checks. Other intents do not matter.
 */
export const locateRecord = (tx: AnyTransaction, record: FinalizedRecord): RecordLocation => {
  const present = new Set(tx.identifiers());
  if (!record.identifiers.every((identifier) => present.has(identifier))) {
    return { contains: false, merged: false, reason: "a recorded identifier is missing" };
  }
  for (const pkg of record.packages) {
    const intent = tx.intents?.get(pkg.segment);
    if (intent === undefined || intent.intentHash(pkg.segment) !== pkg.intentHash) {
      return {
        contains: false,
        merged: false,
        reason: `the package intent at segment ${String(pkg.segment)} differs`,
      };
    }
  }
  try {
    assertTransactionPackages(tx, expectedFromRecord(record), "locate");
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
