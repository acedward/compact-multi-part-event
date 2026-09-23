/**
 * In-process ledger-v9 harness (ported from the prototype soundness audit, section
 * B): a blank `LedgerState`, real `ContractDeploy` transactions, and
 * `wellFormed` + `LedgerState.apply` with balancing, signatures and contract proofs
 * relaxed (no wallet or DUST here; the published wasm build does not verify contract
 * proofs anyway, so nothing here claims to).
 */
import {
  type CallProofData,
  ContractState as RuntimeContractState,
  createCircuitContext,
} from "@midnight-ntwrk/compact-runtime";
import * as ledger from "@midnightntwrk/ledger-v9";

import { emitterAuthorityOf, type EmitterPrivateState } from "../../src/contract/index.js";
import {
  bindingFromContract,
  canonicalKeyLocation,
  type EmissionBinding,
  type PublicationConfig,
  type PublicationStateSource,
} from "../../src/transaction/index.js";
import type { AnyTransaction } from "../../src/codec/raw-transaction.js";
import {
  COIN_PUBLIC_KEY,
  EMITTER_VERIFIER_KEY,
  emitterContract,
  emitterInitialState,
} from "./generated.js";

export const NETWORK = "cmse-local";

export interface Strictness {
  readonly enforceBalancing?: boolean;
  readonly verifyNativeProofs?: boolean;
  readonly verifyContractProofs?: boolean;
  readonly enforceLimits?: boolean;
  readonly verifySignatures?: boolean;
}

export const strictness = (options: Strictness = {}): ledger.WellFormedStrictness => {
  const value = new ledger.WellFormedStrictness();
  value.enforceBalancing = options.enforceBalancing ?? false;
  value.verifyNativeProofs = options.verifyNativeProofs ?? true;
  value.verifyContractProofs = options.verifyContractProofs ?? false;
  value.enforceLimits = options.enforceLimits ?? true;
  value.verifySignatures = options.verifySignatures ?? false;
  return value;
};

/** One block per applied transaction, six seconds apart. */
export class LocalChain {
  state: ledger.LedgerState;
  time: Date;
  height = 1;
  parentBlockHash = "ab".repeat(32);
  latestBlockCalls = 0;
  stateCalls: { address: string; blockHash: string }[] = [];

  constructor(start = new Date("2026-09-23T00:00:00Z")) {
    this.state = ledger.LedgerState.blank(NETWORK);
    this.time = new Date(Math.floor(start.getTime() / 1000) * 1000);
  }

  get seconds(): number {
    return Math.floor(this.time.getTime() / 1000);
  }

  blockContext(): ledger.BlockContext {
    const secondsSinceEpoch = BigInt(this.seconds);
    return {
      secondsSinceEpoch,
      secondsSinceEpochErr: 0,
      parentBlockHash: this.parentBlockHash,
      lastBlockTime: secondsSinceEpoch - 6n,
    };
  }

  /** A copy positioned at the same state (for experiments that must not advance this chain). */
  fork(): LocalChain {
    const copy = new LocalChain(this.time);
    copy.state = this.state;
    copy.height = this.height;
    copy.parentBlockHash = this.parentBlockHash;
    return copy;
  }

  verify(tx: AnyTransaction, options: Strictness = {}): ledger.VerifiedTransaction {
    return tx.wellFormed(this.state, strictness(options), this.time);
  }

  apply(tx: AnyTransaction, options: Strictness = {}): ledger.TransactionResult {
    return this.applyVerified(this.verify(tx, options));
  }

  applyVerified(verified: ledger.VerifiedTransaction): ledger.TransactionResult {
    const [next, result] = this.state.apply(
      verified,
      new ledger.TransactionContext(this.state, this.blockContext()),
    );
    this.state = next;
    this.time = new Date(this.time.getTime() + 6000);
    this.state = this.state.postBlockUpdate(this.time);
    this.height += 1;
    this.parentBlockHash = this.height.toString(16).padStart(64, "0");
    return result;
  }

  /** Public-data source over this chain (counts calls; pins by block hash). */
  source(): PublicationStateSource {
    return {
      latestBlock: () => {
        this.latestBlockCalls += 1;
        return Promise.resolve({
          hash: this.parentBlockHash,
          height: this.height,
          timestampSeconds: this.seconds,
        });
      },
      contractStateAt: (address, blockHash) => {
        this.stateCalls.push({ address, blockHash });
        if (blockHash !== this.parentBlockHash)
          return Promise.reject(new Error("unknown block hash"));
        const contractState = this.state.index(address);
        if (contractState === undefined) return Promise.reject(new Error(`no contract ${address}`));
        return Promise.resolve({ contractState, ledgerParameters: this.state.parameters });
      },
    };
  }
}

/** Install a deployable contract state through a real `ContractDeploy`. Returns the address. */
export const deploy = (chain: LocalChain, runtimeState: RuntimeContractState): string => {
  const contractDeploy = new ledger.ContractDeploy(
    ledger.ContractState.deserialize(runtimeState.serialize()),
  );
  const tx = ledger.Transaction.fromParts(
    NETWORK,
    undefined,
    undefined,
    ledger.Intent.new(new Date(chain.time.getTime() + 10 * 60 * 1000)).addDeploy(contractDeploy),
  );
  const result = chain.apply(tx.eraseProofs());
  if (result.type !== "success")
    throw new Error(`deploy failed: ${result.type} ${String(result.error)}`);
  return contractDeploy.address;
};

/** Deploy the reference emitter with the committed verifier key for `secret`'s authority. */
export const deployEmitter = async (chain: LocalChain, secret: Uint8Array): Promise<string> => {
  const state = await emitterInitialState(emitterAuthorityOf(secret));
  const operation = state.operation("emitPart");
  if (operation === undefined) throw new Error("no emitPart operation");
  operation.verifierKey = EMITTER_VERIFIER_KEY;
  state.setOperation("emitPart", operation);
  return deploy(chain, state);
};

export const emitterBinding = (secret: Uint8Array): EmissionBinding<EmitterPrivateState> =>
  bindingFromContract(emitterContract(), "emitPart", () => ({ emitterSecret: secret }));

export const configFor = (
  emitter: string,
  overrides: Partial<PublicationConfig> = {},
): PublicationConfig => ({
  network: NETWORK,
  emitter,
  coinPublicKey: COIN_PUBLIC_KEY,
  ...overrides,
});

/** Execute one emitter part directly (for hand-assembled test transactions). */
export const emitterTrace = async (
  chain: LocalChain,
  emitter: string,
  secret: Uint8Array,
  requestId: Uint8Array,
  tail: Uint8Array,
): Promise<CallProofData> => {
  const state = chain.state.index(emitter);
  if (state === undefined) throw new Error("emitter missing");
  const result = await emitterContract().circuits.emitPart(
    createCircuitContext(
      "emitPart",
      emitter,
      COIN_PUBLIC_KEY,
      RuntimeContractState.deserialize(state.serialize()),
      { emitterSecret: secret },
      undefined,
      undefined,
      undefined,
      chain.seconds,
      chain.parentBlockHash,
    ),
    requestId,
    tail,
  );
  const [trace] = result.context.callProofDataTrace;
  if (trace === undefined) throw new Error("no trace");
  return trace;
};

export interface CallSpec {
  readonly trace: CallProofData;
  readonly guaranteed?: ledger.Transcript<ledger.AlignedValue> | undefined;
  readonly fallible?: ledger.Transcript<ledger.AlignedValue> | undefined;
}

/** One intent at `segment` holding the given calls (already partitioned transcripts). */
export const assembleIntent = (
  chain: LocalChain,
  emitter: string,
  segment: number,
  specs: readonly CallSpec[],
): ledger.UnprovenTransaction => {
  const state = chain.state.index(emitter);
  if (state === undefined) throw new Error("emitter missing");
  let intent = ledger.Intent.new(new Date(chain.time.getTime() + 10 * 60 * 1000));
  for (const spec of specs) {
    const operation = state.operation("emitPart");
    if (operation === undefined) throw new Error("no operation");
    intent = intent.addCall(
      new ledger.ContractCallPrototype(
        emitter,
        "emitPart",
        operation,
        spec.guaranteed,
        spec.fallible,
        spec.trace.privateTranscriptOutputs,
        spec.trace.input,
        spec.trace.output,
        ledger.communicationCommitmentRandomness(),
        canonicalKeyLocation({
          address: emitter,
          entryPoint: "emitPart",
          verifierKey: operation.verifierKey,
        }),
      ),
    );
  }
  return ledger.Transaction.fromParts(NETWORK).addIntent(
    { tag: "specific", value: segment },
    intent,
  );
};

/** Guaranteed transcripts of the calls in the intent at `segment`. */
export const transcriptsAt = (
  tx: AnyTransaction,
  segment: number,
): ledger.Transcript<ledger.AlignedValue>[] =>
  (tx.intents?.get(segment)?.actions ?? []).map((action) => {
    if (!(action instanceof ledger.ContractCall) || action.guaranteedTranscript === undefined) {
      throw new Error("expected a guaranteed call");
    }
    return action.guaranteedTranscript;
  });

/** A transcript whose compute budget is too small to run (fails when applied). */
export const starve = (
  transcript: ledger.Transcript<ledger.AlignedValue>,
): ledger.Transcript<ledger.AlignedValue> => ({
  ...transcript,
  gas: { ...transcript.gas, computeTime: 1n },
});

/** Flip one byte of the logged event value inside a transcript (after the prefix). */
export const tamperTranscript = (
  transcript: ledger.Transcript<ledger.AlignedValue>,
  byteIndex = 100,
): ledger.Transcript<ledger.AlignedValue> => ({
  ...transcript,
  program: transcript.program.map((op) => {
    if (typeof op === "string" || !("push" in op) || op.push.value.tag !== "array") return op;
    const content = op.push.value.content.map((item, index) => {
      if (index !== 2 || item.tag !== "cell") return item;
      const atom = item.content.value[0] ?? new Uint8Array();
      const bytes = new Uint8Array(Math.max(atom.byteLength, byteIndex + 1));
      bytes.set(atom);
      bytes[byteIndex] = (bytes[byteIndex] ?? 0) ^ 0x01;
      return { ...item, content: { ...item.content, value: [bytes] } };
    });
    return { push: { ...op.push, value: { ...op.push.value, content } } };
  }),
});
