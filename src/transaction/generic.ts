/**
 * Finalize and submit transactions other than publications (a deployment, a
 * registration or a release) with the same discipline as publications: one proof, one
 * balancing, a caller-supplied intent check before proving, after proving, after
 * balancing and after a serialization round trip, the cost check against the pinned
 * ledger parameters, and submission of exactly the saved bytes.
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
import {
  blockFullnessCheck,
  type CostCheck,
  type PublicationBalancer,
  type PublicationProver,
  type PublicationSubmitter,
} from "./finalize.js";
import { PublicationCheckError } from "./guard.js";

/** Checks the caller's own intent at one stage; throws {@link PublicationCheckError}. */
export type IntentCheck = (tx: AnyTransaction, stage: string) => void;

/** The public record of a finalized transaction (JSON-safe). */
export interface FinalizedTransactionRecord {
  readonly network: string;
  /** What the transaction does, e.g. `deploy`, `register3`. */
  readonly purpose: string;
  readonly transactionHex: string;
  /** `null` only for unproven stand-ins in offline tests. */
  readonly transactionHash: string | null;
  readonly identifiers: readonly string[];
  readonly ttl: string;
  readonly blockHash: string;
  readonly blockHeight: number;
}

/** Options for {@link finalizeTransaction}. */
export interface FinalizeTransactionOptions {
  readonly network: string;
  readonly purpose: string;
  readonly proofTimeoutMs: number;
  readonly ttl: Date;
  readonly ledgerParameters: ledger.LedgerParameters;
  readonly block: { readonly hash: string; readonly height: number };
  readonly check: IntentCheck;
  readonly costCheck?: CostCheck;
  /** Require the final bytes to be proven and bound (default true). */
  readonly requireProofs?: boolean;
}

const requireTransaction = (value: unknown, stage: string, provider: string): void => {
  if (!(value instanceof ledger.Transaction)) {
    throw new PublicationCheckError(
      stage,
      `the ${provider} did not return a ledger-v9 transaction of this process`,
    );
  }
};

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

/**
 * Prove once, balance once (passing the TTL), and run the intent and cost checks at
 * every stage.
 */
export const finalizeTransaction = async (
  providers: { readonly prover: PublicationProver; readonly balancer: PublicationBalancer },
  unproven: ledger.UnprovenTransaction,
  options: FinalizeTransactionOptions,
): Promise<FinalizedTransactionRecord> => {
  const costCheck = options.costCheck ?? blockFullnessCheck();
  const requireProofs = options.requireProofs ?? true;
  options.check(unproven, "before proving");
  const proven = await providers.prover.proveTx(unproven, { timeout: options.proofTimeoutMs });
  requireTransaction(proven, "after proving", "prover");
  options.check(proven, "after proving");
  costCheck(proven, options.ledgerParameters, "after proving");
  const finalized = await providers.balancer.balanceTx(proven, options.ttl);
  requireTransaction(finalized, "after balancing", "balancer");
  options.check(finalized, "after balancing");
  costCheck(finalized, options.ledgerParameters, "after balancing");
  const bytes = finalized.serialize();
  const roundTrip = deserializeFinal(bytes, requireProofs);
  options.check(roundTrip, "after serialization");
  return {
    network: options.network,
    purpose: options.purpose,
    transactionHex: bytesToHex(bytes),
    transactionHash: transactionHashOf(roundTrip) ?? null,
    identifiers: roundTrip.identifiers(),
    ttl: options.ttl.toISOString(),
    blockHash: options.block.hash,
    blockHeight: options.block.height,
  };
};

/**
 * Submit exactly the saved bytes once, after re-running the intent check and
 * comparing hash and identifiers with the record.
 */
export const submitSavedTransaction = async (
  submitter: PublicationSubmitter,
  record: FinalizedTransactionRecord,
  check: IntentCheck,
  options: { readonly requireProofs?: boolean } = {},
): Promise<string> => {
  const stage = "before submission";
  const snapshot = deserializeFinal(
    hexToBytes(record.transactionHex),
    options.requireProofs ?? true,
  );
  check(snapshot, stage);
  if ((transactionHashOf(snapshot) ?? null) !== record.transactionHash) {
    throw new PublicationCheckError(stage, "saved bytes do not match the recorded hash");
  }
  const identifiers = snapshot.identifiers();
  if (
    identifiers.length !== record.identifiers.length ||
    identifiers.some((identifier, index) => identifier !== record.identifiers[index])
  ) {
    throw new PublicationCheckError(stage, "saved bytes do not match the recorded identifiers");
  }
  return await submitter.submitTx(snapshot as ledger.FinalizedTransaction);
};
