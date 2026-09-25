/**
 * Client for the notice-board example, a second adopter of the multi-part rule with
 * state of its own. Its protocol emits notices as `Misc` events named
 * `notice-board:notice[v1]` and declares that this name follows the rule; its notice
 * format is a 4-byte big-endian length, the UTF-8 text, then zero padding, which reads
 * the same at any multiple of 256 bytes.
 *
 * Everything from the library comes through its public entry points (`/publisher`,
 * `/reader`); the rest is this contract's own generated binding.
 */
import {
  type CircuitContext,
  ContractState as RuntimeContractState,
  createCircuitContext,
} from "@midnight-ntwrk/compact-runtime";
import * as ledger from "@midnightntwrk/ledger-v9";
import {
  addGuaranteedIntent,
  bindingFromContract,
  canonicalKeyLocation,
  DEFAULT_MAX_ASSEMBLY_ATTEMPTS,
  type EmissionBinding,
  type PackageRequest,
  prePartitionCallFor,
  type PublicationStateSource,
  splitPayload,
} from "compact-multi-segment-emit/publisher";
import type { OptIn, PlacementTarget } from "compact-multi-segment-emit/reader";

import { Contract, ledger as boardLedger, pureCircuits } from "../managed/contract/index.js";

/** The board protocol's event name, opted into the multi-part rule. */
export const NOTICE_EVENT = "notice-board:notice[v1]";

/** The board's emitting circuit. */
export const EMIT_CIRCUIT = "emitPart";

/** Private state answering the whitelist witness `emitterSecret`. */
export interface BoardPrivateState {
  readonly emitterSecret: Uint8Array;
}

const witnesses = {
  emitterSecret: ({
    privateState,
  }: {
    readonly privateState: BoardPrivateState;
  }): [BoardPrivateState, Uint8Array] => {
    if (privateState.emitterSecret.byteLength !== 32) {
      throw new RangeError("the emitter secret must be 32 bytes");
    }
    return [privateState, privateState.emitterSecret];
  },
};

export type Board = Contract<BoardPrivateState>;

/** A board contract instance with the whitelist witness. */
export const board = (): Board => new Contract<BoardPrivateState>(witnesses);

/** The authority commitment the constructor stores for a secret (the board's own pure circuit). */
export const boardAuthorityOf = (secret: Uint8Array): Uint8Array =>
  pureCircuits.emitterAuthorityOf(secret);

/** The publisher binding: the board's `emitPart`, answered with the emitter's secret. */
export const boardBinding = (secret: Uint8Array): EmissionBinding<BoardPrivateState> =>
  bindingFromContract(board(), EMIT_CIRCUIT, () => ({ emitterSecret: secret }));

/** Encode a notice in the board's format: u32 big-endian length, UTF-8 text. */
export const encodeNotice = (text: string): Uint8Array => {
  const body = new TextEncoder().encode(text);
  const out = new Uint8Array(4 + body.byteLength);
  new DataView(out.buffer).setUint32(0, body.byteLength, false);
  out.set(body, 4);
  return out;
};

/**
 * Decode a merged package payload as a notice: the board's processing of a normal
 * notice event. The padding after the text must be zero.
 *
 * @throws {RangeError} If the payload is not a notice.
 */
export const decodeNotice = (payload: Uint8Array): string => {
  if (payload.byteLength < 4) throw new RangeError("a notice needs its 4-byte length");
  const length = new DataView(payload.buffer, payload.byteOffset).getUint32(0, false);
  if (4 + length > payload.byteLength)
    throw new RangeError("the notice is longer than its package");
  if (payload.subarray(4 + length).some((byte) => byte !== 0)) {
    throw new RangeError("the notice's padding is not zero");
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(payload.subarray(4, 4 + length));
};

/** One notice as a package request for the publisher. */
export const noticeRequest = (
  address: string,
  secret: Uint8Array,
  text: string,
): PackageRequest<BoardPrivateState> => ({
  contract: address,
  name: NOTICE_EVENT,
  binding: boardBinding(secret),
  parts: splitPayload(encodeNotice(text)),
});

/** The reader configuration for a board: its address and its event name. */
export const boardOptIn = (address: string): OptIn => ({ contract: address, name: NOTICE_EVENT });

/** The placement target for a board (verification Level 2). */
export const boardPlacement = (address: string): PlacementTarget => ({
  contract: address,
  entryPoint: EMIT_CIRCUIT,
  name: NOTICE_EVENT,
});

/** The board's public ledger, decoded by its generated binding. */
export const readBoard = (state: Parameters<typeof boardLedger>[0]) => {
  const view = boardLedger(state);
  return {
    authority: view.emitterAuthority,
    pinnedCount: view.pinnedCount,
    pinnedDigest: view.pinnedDigest,
  };
};

/**
 * Build the unproven transaction for `pin(digest)`: one guaranteed call, in its own
 * transaction (it writes state, so it is never batched with parts).
 */
export const buildPinTransaction = async (
  source: PublicationStateSource,
  target: { readonly network: string; readonly address: string; readonly coinPublicKey: string },
  secret: Uint8Array,
  digest: Uint8Array,
): Promise<ledger.UnprovenTransaction> => {
  const block = await source.latestBlock();
  const snapshot = await source.contractStateAt(target.address, block.hash);
  const bytes = snapshot.contractState.serialize();
  const ledgerState = ledger.ContractState.deserialize(bytes);
  const verifierKey = ledgerState.operation("pin")?.verifierKey;
  if (verifierKey === undefined) throw new Error("the board has no pin operation");
  const context: CircuitContext<BoardPrivateState> = createCircuitContext(
    "pin",
    target.address,
    target.coinPublicKey,
    RuntimeContractState.deserialize(bytes),
    { emitterSecret: secret },
    undefined,
    undefined,
    undefined,
    block.timestampSeconds,
    block.hash,
  );
  const result = await board().impureCircuits.pin(context, digest);
  const [trace] = result.context.callProofDataTrace;
  if (trace === undefined) throw new Error("pin produced no call trace");
  const keyLocation = canonicalKeyLocation({
    address: target.address,
    entryPoint: "pin",
    verifierKey,
  });
  const ttl = new Date((block.timestampSeconds + 600) * 1000);
  return addGuaranteedIntent(
    ledger.Transaction.fromPartsRandomized(target.network),
    () => [prePartitionCallFor(trace, ledgerState, keyLocation)],
    snapshot.ledgerParameters,
    ttl,
    DEFAULT_MAX_ASSEMBLY_ATTEMPTS,
  ).transaction;
};
