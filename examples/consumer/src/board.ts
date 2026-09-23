/**
 * Client for the consumer example (a notice board): it binds the library's public
 * transaction composer to this contract's own generated binding. Everything from the
 * library comes through its public entry points; nothing here imports library
 * internals, tests or the reference emitter.
 */
import type { CircuitContext } from "@midnight-ntwrk/compact-runtime";
import {
  type MessageOwnerPrivateState,
  messageOwnerOf,
  messageOwnerWitnesses,
} from "compact-multi-segment-emit/contract";
import type { EncodedPublication } from "compact-multi-segment-emit/codec";
import {
  bindingFromContract,
  type CircuitCallPlan,
  type EmissionBinding,
} from "compact-multi-segment-emit/transaction";

import { Contract, ledger as boardLedger } from "../managed/consumer/contract/index.js";

export type Board = Contract<MessageOwnerPrivateState>;

/** A board contract instance with the owner-secret witness. */
export const board = (): Board => new Contract<MessageOwnerPrivateState>(messageOwnerWitnesses);

/** Registration sizes the board exports (`register<N>`). */
export const REGISTRATION_SIZES = [1, 2, 3, 5] as const;

/** The composer binding: the board's `emitPart`, answered with the owner's secret. */
export const boardBinding = (ownerSecret: Uint8Array): EmissionBinding<MessageOwnerPrivateState> =>
  bindingFromContract(board(), "emitPart", () => ({ messageOwnerSecret: ownerSecret }));

type RegisterRun = (
  context: CircuitContext<MessageOwnerPrivateState>,
  requestId: Uint8Array,
  tails: Uint8Array[],
) => ReturnType<Board["impureCircuits"]["register1"]>;

const registerCircuit = (parts: number): { readonly name: string; readonly run: RegisterRun } => {
  const circuits = board().impureCircuits;
  switch (parts) {
    case 1:
      return { name: "register1", run: (ctx, id, tails) => circuits.register1(ctx, id, tails) };
    case 2:
      return { name: "register2", run: (ctx, id, tails) => circuits.register2(ctx, id, tails) };
    case 3:
      return { name: "register3", run: (ctx, id, tails) => circuits.register3(ctx, id, tails) };
    case 5:
      return { name: "register5", run: (ctx, id, tails) => circuits.register5(ctx, id, tails) };
    default:
      throw new RangeError(
        `the board registers messages of ${REGISTRATION_SIZES.join(", ")} parts, not ${String(parts)}`,
      );
  }
};

/** Common fields of a single-call plan on the board. */
export interface BoardCallTarget {
  readonly network: string;
  readonly address: string;
  readonly coinPublicKey: string;
}

/**
 * Plan the registration of a publication (`register<N>`), to be submitted in its own
 * transaction BEFORE the parts: the tails are private inputs of this proof.
 */
export const registrationPlan = (
  target: BoardCallTarget,
  publication: EncodedPublication,
  ownerSecret: Uint8Array,
): CircuitCallPlan<MessageOwnerPrivateState> => {
  const circuit = registerCircuit(publication.parts.length);
  const tails = publication.parts.map((part) => part.tail);
  return {
    ...target,
    circuit: circuit.name,
    privateState: { messageOwnerSecret: ownerSecret },
    execute: (context: CircuitContext<MessageOwnerPrivateState>) =>
      circuit.run(context, publication.requestId, tails),
  };
};

/** Plan the application step `announce(requestId)`, AFTER the publication. */
export const announcePlan = (
  target: BoardCallTarget,
  requestId: Uint8Array,
  ownerSecret: Uint8Array,
): CircuitCallPlan<MessageOwnerPrivateState> => ({
  ...target,
  circuit: "announce",
  privateState: { messageOwnerSecret: ownerSecret },
  execute: (context) => board().impureCircuits.announce(context, requestId),
});

/** Plan the owner-only `release(requestId)`, after every part. */
export const releasePlan = (
  target: BoardCallTarget,
  requestId: Uint8Array,
  ownerSecret: Uint8Array,
): CircuitCallPlan<MessageOwnerPrivateState> => ({
  ...target,
  circuit: "release",
  privateState: { messageOwnerSecret: ownerSecret },
  execute: (context) => board().impureCircuits.release(context, requestId),
});

/** The board's public ledger, decoded by its generated binding. */
export const readBoard = (state: Parameters<typeof boardLedger>[0]) => {
  const view = boardLedger(state);
  return {
    announcements: view.announcements,
    latestAnnouncement: view.latestAnnouncement,
    ownerOf: (requestId: Uint8Array): Uint8Array | undefined =>
      view.messageOwner.member(requestId) ? view.messageOwner.lookup(requestId) : undefined,
  };
};

/** The owner commitment the registry stores for a secret. */
export const ownerCommitment = (ownerSecret: Uint8Array): Uint8Array => messageOwnerOf(ownerSecret);
