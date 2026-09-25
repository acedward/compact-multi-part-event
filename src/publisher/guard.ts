/**
 * Publisher-side checks of a package's intent at every construction stage.
 *
 * Midnight transactions stay mergeable after sealing, so the checks look only at the
 * package's own intent (found by its segment). Other intents are ignored, including
 * other intents that call the same contract: each intent is its own package. The
 * ledger JS API exposes no network getter; the network is fixed at construction and by
 * the chain.
 *
 * @module
 */
import { isDeepStrictEqual } from "node:util";

import * as ledger from "@midnightntwrk/ledger-v9";

import { bytesEqual } from "../reader/bytes.js";
import { eventValue, NAME_LENGTH } from "../reader/event.js";
import {
  type AnyTransaction,
  decodeMiscValue,
  entryPointText,
  loggedEvents,
  MISC_EVENT_TYPE_CODE,
} from "../reader/transaction.js";
import { PART_LENGTH } from "./parts.js";

/** Everything a package's intent must contain, in order. */
export interface ExpectedPackage {
  readonly network: string;
  /** Contract address, 64 lowercase hex characters. */
  readonly contract: string;
  /** The emitting circuit. */
  readonly entryPoint: string;
  /** The event name N, 32 bytes. */
  readonly name: Uint8Array;
  /** Physical segment of the package's intent (1..65535). */
  readonly segment: number;
  /** The parts in order; one guaranteed call of the emitting circuit per part. */
  readonly parts: readonly Uint8Array[];
}

/** Thrown when a package check fails; names the construction stage. */
export class PackageCheckError extends Error {
  constructor(
    readonly stage: string,
    detail: string,
  ) {
    super(`${stage}: ${detail}`);
    this.name = "PackageCheckError";
  }
}

/**
 * Check one package's intent at one construction stage.
 *
 * Requires, within the intent at `expected.segment`: exactly one action per part, each
 * a call to the expected contract and circuit, with a guaranteed transcript, no
 * fallible transcript, and a transcript that logs exactly one event: the `Misc` event
 * with name N and part k's payload at position k; no unshielded offers or DUST actions
 * in that intent; and no fallible Zswap offer in its segment. Nothing outside that
 * intent is checked.
 *
 * @param frozen - Optional guaranteed transcripts frozen at assembly (in-memory
 * comparison only; never persisted).
 * @throws {PackageCheckError} On the first violated rule.
 */
export const assertPackageIntent = (
  tx: AnyTransaction,
  expected: ExpectedPackage,
  stage: string,
  frozen?: readonly ledger.Transcript<ledger.AlignedValue>[],
): void => {
  const fail = (detail: string): never => {
    throw new PackageCheckError(stage, detail);
  };
  const count = expected.parts.length;
  if (count < 1) fail("a package needs at least one part");
  if (expected.name.byteLength !== NAME_LENGTH) fail("the event name is not 32 bytes");
  if (!Number.isInteger(expected.segment) || expected.segment < 1 || expected.segment > 65535) {
    fail(`package segment ${String(expected.segment)} is not in 1..65535`);
  }
  const intent = tx.intents?.get(expected.segment);
  if (intent === undefined) {
    return fail(`no intent at package segment ${String(expected.segment)}`);
  }
  if (intent.actions.length !== count) {
    fail(
      `the package intent has ${String(intent.actions.length)} actions, expected ${String(count)}`,
    );
  }
  intent.actions.forEach((action, index) => {
    const label = `call ${String(index + 1)}`;
    if (!(action instanceof ledger.ContractCall)) return fail(`${label} is not a contract call`);
    if (action.address !== expected.contract) fail(`${label} targets another contract`);
    if (entryPointText(action.entryPoint) !== expected.entryPoint) {
      fail(`${label} uses another entry point`);
    }
    if (action.fallibleTranscript !== undefined) fail(`${label} has a fallible transcript`);
    const guaranteed = action.guaranteedTranscript;
    if (guaranteed === undefined) return fail(`${label} has no guaranteed transcript`);
    let value: Uint8Array;
    try {
      const events = loggedEvents(guaranteed.program);
      if (events.length !== 1) fail(`${label} logs ${String(events.length)} events, expected 1`);
      const [event] = events;
      if (event === undefined || event.typeCode !== MISC_EVENT_TYPE_CODE) {
        return fail(`${label} logs a non-Misc event`);
      }
      value = decodeMiscValue(event.data);
    } catch (error) {
      if (error instanceof PackageCheckError) throw error;
      return fail(`${label} transcript: ${error instanceof Error ? error.message : String(error)}`);
    }
    const part = expected.parts[index];
    if (
      part === undefined ||
      part.byteLength !== PART_LENGTH ||
      !bytesEqual(value, eventValue(expected.name, part))
    ) {
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
    fail("the package intent carries an unshielded offer");
  }
  if (intent.dustActions !== undefined) fail("the package intent carries DUST actions");
  if (tx.fallibleOffer?.get(expected.segment) !== undefined) {
    fail("the package segment carries a fallible Zswap offer");
  }
};

/**
 * Check every package of a transaction at one stage: each package's own intent (see
 * {@link assertPackageIntent}), and one intent per package (no two packages share a
 * segment). A package split over two intents, or two packages put into one intent,
 * fails the action count of its intent.
 *
 * @param frozen - Optional frozen transcripts per package, in the same order.
 * @throws {PackageCheckError} On the first violated rule.
 */
export const assertTransactionPackages = (
  tx: AnyTransaction,
  expected: readonly ExpectedPackage[],
  stage: string,
  frozen?: readonly (readonly ledger.Transcript<ledger.AlignedValue>[])[],
): void => {
  if (expected.length === 0) throw new PackageCheckError(stage, "no package expected");
  const segments = new Set<number>();
  for (const pkg of expected) {
    if (segments.has(pkg.segment)) {
      throw new PackageCheckError(
        stage,
        `packages share segment ${String(pkg.segment)}: one intent per package`,
      );
    }
    segments.add(pkg.segment);
  }
  expected.forEach((pkg, index) => {
    assertPackageIntent(
      tx,
      pkg,
      expected.length === 1 ? stage : `${stage} (package ${String(index + 1)})`,
      frozen?.[index],
    );
  });
};
