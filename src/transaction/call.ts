/**
 * A transaction with ONE guaranteed call to a contract circuit, for the steps around a
 * publication: the optional registration (`register<N>`, which must be its own,
 * earlier transaction), an owner-only release, or an application circuit.
 *
 * Unlike the parts of a publication, such a call may write contract state, so it is
 * never batched with parts executed from the same pre-state.
 *
 * @module
 */
import {
  type CircuitContext,
  type CircuitResults,
  ContractState as RuntimeContractState,
  createCircuitContext,
} from "@midnight-ntwrk/compact-runtime";
import * as ledger from "@midnightntwrk/ledger-v9";

import type { AnyTransaction } from "../codec/raw-transaction.js";
import {
  canonicalKeyLocation,
  DEFAULT_MAX_ASSEMBLY_ATTEMPTS,
  DEFAULT_TTL_SECONDS,
  type KeyLocationResolver,
  type PinnedBlock,
  prePartitionCallFor,
  type PublicationStateSource,
  retryUntilNonZeroSegment,
  singleSegment,
} from "./compose.js";
import { PublicationCheckError } from "./guard.js";

/** One circuit call to build. */
export interface CircuitCallPlan<PS> {
  readonly network: string;
  /** Contract address, 64 lowercase hex characters. */
  readonly address: string;
  /** The circuit (entry point) to call. */
  readonly circuit: string;
  /** The submitting wallet's coin public key. */
  readonly coinPublicKey: string;
  /** Runs the generated circuit, e.g. `(ctx) => contract.impureCircuits.register3(ctx, id, tails)`. */
  readonly execute: (context: CircuitContext<PS>) => Promise<CircuitResults<PS, unknown>>;
  /** Private state answering the circuit's witnesses. */
  readonly privateState: PS;
  /** TTL after the pinned block time (default 1200 s). */
  readonly ttlSeconds?: number;
  readonly keyLocation?: KeyLocationResolver;
}

/** A built single-call transaction. */
export interface BuiltCall {
  readonly transaction: ledger.UnprovenTransaction;
  readonly address: string;
  readonly circuit: string;
  readonly segment: number;
  readonly block: PinnedBlock;
  readonly ledgerParameters: ledger.LedgerParameters;
  readonly ttl: Date;
}

const entryPointText = (entryPoint: string | Uint8Array): string =>
  typeof entryPoint === "string" ? entryPoint : new TextDecoder().decode(entryPoint);

/**
 * Execute one circuit against the state at the latest block and assemble it as one
 * guaranteed call.
 *
 * @throws {PublicationCheckError} If execution makes cross-contract calls or touches
 * shielded coins (outside this helper's scope), or the circuit fails.
 */
export const buildCircuitCallTransaction = async <PS>(
  source: PublicationStateSource,
  plan: CircuitCallPlan<PS>,
): Promise<BuiltCall> => {
  if (!/^[0-9a-f]{64}$/.test(plan.address)) {
    throw new RangeError("address must be 64 lowercase hex characters");
  }
  const block = await source.latestBlock();
  const snapshot = await source.contractStateAt(plan.address, block.hash);
  const stateBytes = snapshot.contractState.serialize();
  const runtimeState = RuntimeContractState.deserialize(stateBytes);
  const ledgerState = ledger.ContractState.deserialize(stateBytes);
  const verifierKey = ledgerState.operation(plan.circuit)?.verifierKey;
  if (verifierKey === undefined || verifierKey.byteLength === 0) {
    throw new Error(`contract has no verifier key for '${plan.circuit}'`);
  }
  const context = createCircuitContext(
    plan.circuit,
    plan.address,
    plan.coinPublicKey,
    runtimeState,
    plan.privateState,
    undefined,
    undefined,
    undefined,
    block.timestampSeconds,
    block.hash,
  );
  const result = await plan.execute(context);
  const traces = result.context.callProofDataTrace;
  const [trace] = traces;
  if (traces.length !== 1 || trace === undefined) {
    throw new PublicationCheckError("execution", `produced ${String(traces.length)} call traces`);
  }
  if (trace.contractAddress !== plan.address || trace.circuitId !== plan.circuit) {
    throw new PublicationCheckError("execution", "trace targets another contract or circuit");
  }
  if (trace.commCommData !== undefined) {
    throw new PublicationCheckError("execution", "the circuit made a cross-contract call");
  }
  const zswap = trace.zswapLocalState as {
    inputs?: readonly unknown[];
    outputs?: readonly unknown[];
  };
  if ((zswap.inputs?.length ?? 0) > 0 || (zswap.outputs?.length ?? 0) > 0) {
    throw new PublicationCheckError("execution", "the circuit touched shielded coins");
  }
  const keyLocation = (plan.keyLocation ?? canonicalKeyLocation)({
    address: plan.address,
    entryPoint: plan.circuit,
    verifierKey,
  });
  const ttl = new Date((block.timestampSeconds + (plan.ttlSeconds ?? DEFAULT_TTL_SECONDS)) * 1000);
  const assembled = retryUntilNonZeroSegment(
    () =>
      ledger.Transaction.fromPartsRandomized(plan.network).addCalls(
        { tag: "guaranteedOnly" },
        [prePartitionCallFor(trace, ledgerState, keyLocation)],
        snapshot.ledgerParameters,
        ttl,
      ),
    singleSegment,
    DEFAULT_MAX_ASSEMBLY_ATTEMPTS,
  );
  const built: BuiltCall = {
    transaction: assembled.value,
    address: plan.address,
    circuit: plan.circuit,
    segment: assembled.segment,
    block,
    ledgerParameters: snapshot.ledgerParameters,
    ttl,
  };
  callIntentCheck(built)(built.transaction, "after assembly");
  return built;
};

/**
 * Check the call's own intent: exactly one guaranteed-only call to the address and
 * circuit, no offers or DUST actions in that intent, and no call to that circuit in
 * any other intent.
 */
export const callIntentCheck =
  (built: Pick<BuiltCall, "address" | "circuit" | "segment">) =>
  (tx: AnyTransaction, stage: string): void => {
    const fail = (detail: string): never => {
      throw new PublicationCheckError(stage, detail);
    };
    const intent = tx.intents?.get(built.segment);
    if (intent === undefined) return fail(`no intent at segment ${String(built.segment)}`);
    if (intent.actions.length !== 1)
      fail(`the call intent has ${String(intent.actions.length)} actions`);
    const [action] = intent.actions;
    if (!(action instanceof ledger.ContractCall)) return fail("the action is not a contract call");
    if (action.address !== built.address || entryPointText(action.entryPoint) !== built.circuit) {
      fail("the call targets another contract or circuit");
    }
    if (action.fallibleTranscript !== undefined) fail("the call has a fallible transcript");
    if (action.guaranteedTranscript === undefined) fail("the call has no guaranteed transcript");
    if (
      intent.guaranteedUnshieldedOffer !== undefined ||
      intent.fallibleUnshieldedOffer !== undefined ||
      intent.dustActions !== undefined
    ) {
      fail("the call intent carries offers or DUST actions");
    }
    for (const [segment, other] of tx.intents ?? []) {
      if (segment === built.segment) continue;
      for (const item of other.actions) {
        if (
          item instanceof ledger.ContractCall &&
          item.address === built.address &&
          entryPointText(item.entryPoint) === built.circuit
        ) {
          fail(`segment ${String(segment)} also calls ${built.circuit}`);
        }
      }
    }
  };
