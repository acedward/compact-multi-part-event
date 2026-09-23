/**
 * Publisher-side checks of the publication intent at every construction stage.
 *
 * Midnight transactions stay mergeable after sealing, so the checks look only at the
 * publication's own intent (found by its segment) and at calls to the expected
 * emitter's entry point; intents others add are ignored. The ledger JS API exposes
 * no network getter; the network is fixed at construction and by the chain.
 *
 * @module
 */
import { isDeepStrictEqual } from "node:util";

import * as ledger from "@midnightntwrk/ledger-v9";

import { bytesEqual } from "../codec/bytes.js";
import { FORMAT_MAX_PARTS } from "../codec/constants.js";
import { type AnyTransaction, decodeMiscValue, loggedEvent } from "../codec/raw-transaction.js";
import { eventValueFor } from "../codec/writer.js";

/** Everything the publication intent must contain, in order. */
export interface ExpectedPublication {
  readonly network: string;
  readonly emitter: string;
  readonly entryPoint: string;
  /** Physical segment of the publication intent (1..65535). */
  readonly segment: number;
  readonly requestId: Uint8Array;
  /** Tails in part order; one guaranteed emission call per tail. */
  readonly tails: readonly Uint8Array[];
}

/** Thrown when a publication check fails; names the construction stage. */
export class PublicationCheckError extends Error {
  constructor(
    readonly stage: string,
    detail: string,
  ) {
    super(`${stage}: ${detail}`);
    this.name = "PublicationCheckError";
  }
}

const MISC_TYPE_CODE = 10;

const entryPointText = (entryPoint: Uint8Array | string): string =>
  typeof entryPoint === "string" ? entryPoint : new TextDecoder().decode(entryPoint);

/**
 * Check the publication intent of a transaction at one construction stage.
 *
 * Requires, within the intent at `expected.segment`: exactly one action per tail, each
 * a call to the expected emitter and entry point, with a guaranteed transcript, no
 * fallible transcript, and a transcript that logs exactly the expected `Misc` event
 * (name and `requestId || tail[k]` at position k); no unshielded offers or DUST
 * actions in that intent; no fallible Zswap offer in its segment; and no call to the
 * emitter's entry point in any other intent.
 *
 * @param frozen - Optional guaranteed transcripts frozen at assembly (in-memory
 * comparison only; never persisted).
 * @throws {PublicationCheckError} On the first violated rule.
 */
export const assertPublicationIntent = (
  tx: AnyTransaction,
  expected: ExpectedPublication,
  stage: string,
  frozen?: readonly ledger.Transcript<ledger.AlignedValue>[],
): void => {
  const fail = (detail: string): never => {
    throw new PublicationCheckError(stage, detail);
  };
  const count = expected.tails.length;
  if (count < 1 || count > FORMAT_MAX_PARTS)
    fail(`expected part count ${String(count)} is out of range`);
  if (!Number.isInteger(expected.segment) || expected.segment < 1 || expected.segment > 65535) {
    fail(`publication segment ${String(expected.segment)} is not in 1..65535`);
  }
  const intents = tx.intents;
  const intent = intents?.get(expected.segment);
  if (intents === undefined || intent === undefined) {
    return fail(`no intent at publication segment ${String(expected.segment)}`);
  }
  if (intent.actions.length !== count) {
    fail(
      `publication intent has ${String(intent.actions.length)} actions, expected ${String(count)}`,
    );
  }
  intent.actions.forEach((action, index) => {
    const label = `call ${String(index + 1)}`;
    if (!(action instanceof ledger.ContractCall)) return fail(`${label} is not a contract call`);
    if (action.address !== expected.emitter) fail(`${label} targets another contract`);
    if (entryPointText(action.entryPoint) !== expected.entryPoint)
      fail(`${label} uses another entry point`);
    if (action.fallibleTranscript !== undefined) fail(`${label} has a fallible transcript`);
    const guaranteed = action.guaranteedTranscript;
    if (guaranteed === undefined) return fail(`${label} has no guaranteed transcript`);
    let value: Uint8Array;
    try {
      const event = loggedEvent(guaranteed.program);
      if (event.typeCode !== MISC_TYPE_CODE) fail(`${label} logs a non-Misc event`);
      value = decodeMiscValue(event.data);
    } catch (error) {
      if (error instanceof PublicationCheckError) throw error;
      return fail(`${label} transcript: ${error instanceof Error ? error.message : String(error)}`);
    }
    const tail = expected.tails[index];
    if (tail === undefined || !bytesEqual(value, eventValueFor(expected.requestId, tail))) {
      fail(`${label} emits bytes other than part ${String(index + 1)}`);
    }
    const reference = frozen?.[index];
    if (
      frozen !== undefined &&
      (reference === undefined || !isDeepStrictEqual(guaranteed, reference))
    ) {
      fail(`${label} guaranteed transcript changed since assembly`);
    }
  });
  if (
    intent.guaranteedUnshieldedOffer !== undefined ||
    intent.fallibleUnshieldedOffer !== undefined
  ) {
    fail("publication intent carries an unshielded offer");
  }
  if (intent.dustActions !== undefined) fail("publication intent carries DUST actions");
  if (tx.fallibleOffer?.get(expected.segment) !== undefined) {
    fail("publication segment carries a fallible Zswap offer");
  }
  for (const [segment, other] of intents) {
    if (segment === expected.segment) continue;
    for (const action of other.actions) {
      if (
        action instanceof ledger.ContractCall &&
        action.address === expected.emitter &&
        entryPointText(action.entryPoint) === expected.entryPoint
      ) {
        fail(`segment ${String(segment)} also calls the emitter's ${expected.entryPoint}`);
      }
    }
  }
};
