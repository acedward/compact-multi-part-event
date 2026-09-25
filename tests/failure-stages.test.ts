/**
 * Where a bad package dies. Calls are re-assembled from real compiled-circuit traces
 * and the publisher's own partitioned transcripts, so only the property under test
 * differs from a genuine package. Each case reports the real stage: the publisher's
 * intent check (before any proof), `wellFormed`, `apply`, the reader over the applied
 * events, or the placement check over the raw transaction.
 */
import type { CallProofData } from "@midnight-ntwrk/compact-runtime";
import * as ledger from "@midnightntwrk/ledger-v9";
import { beforeAll, describe, expect, it } from "vitest";

import {
  assertPackageIntent,
  buildPackageTransaction,
  type BuiltTransaction,
  type ExpectedPackage,
} from "../src/publisher/index.js";
import {
  partEventsFromLedgerEvents,
  readPackages,
  statusFromLedgerResult,
  verifyTransactionPackages,
} from "../src/reader/index.js";
import { filled32, patternParts } from "./helpers/bytes.js";
import { EXAMPLE_NAME } from "./helpers/generated.js";
import {
  assembleIntent,
  type CallSpec,
  configFor,
  deployEmitter,
  emitterBinding,
  LocalChain,
  NETWORK,
  requestFor,
  starve,
  tamperTranscript,
  traceOf,
  transcriptsAt,
} from "./helpers/ledger.js";

type Transcript = ledger.Transcript<ledger.AlignedValue>;

const SECRET = filled32(0x61);
let chain: LocalChain;
let emitter: string;
let parts: Uint8Array[];
let built: BuiltTransaction;
let expected: ExpectedPackage;
let transcripts: Transcript[];
let traces: CallProofData[];

const outcome = (run: () => unknown): string => {
  try {
    run();
    return "accepted";
  } catch (error) {
    return `threw: ${error instanceof Error ? error.message : String(error)}`;
  }
};

/** Publisher check, then wellFormed + apply on a fork, then the reader and the placement check. */
const run = (tx: ledger.UnprovenTransaction) => {
  const guard = outcome(() => {
    assertPackageIntent(tx, expected, "test", built.frozenTranscripts[0]);
  });
  const fork = chain.fork();
  const erased = tx.eraseProofs();
  let wellFormed = "accepted";
  let verified: ledger.VerifiedTransaction | undefined;
  try {
    verified = fork.verify(erased);
  } catch (error) {
    wellFormed = `threw: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (verified === undefined) {
    return {
      guard,
      wellFormed,
      applied: "not applied",
      events: 0,
      read: undefined,
      raw: undefined,
    };
  }
  const before = fork.state.serialize();
  const [after, result] = fork.state.apply(
    verified,
    new ledger.TransactionContext(fork.state, fork.blockContext()),
  );
  const optIns = [{ contract: emitter, name: EXAMPLE_NAME }];
  const read = readPackages(
    partEventsFromLedgerEvents(result.events, { network: NETWORK }).events,
    {
      optIns,
    },
  );
  const raw = verifyTransactionPackages(erased, {
    contract: emitter,
    entryPoint: "emitPart",
    name: EXAMPLE_NAME,
    network: NETWORK,
    status: statusFromLedgerResult(result.type),
    transactionHash: result.events[0]?.source.transactionHash ?? "applied-without-events",
  });
  return {
    guard,
    wellFormed,
    applied: result.type,
    events: result.events.length,
    stateUnchanged: Buffer.compare(Buffer.from(after.serialize()), Buffer.from(before)) === 0,
    read,
    raw,
  };
};

const specs = (
  indexes: readonly number[],
  override?: (index: number) => Partial<CallSpec>,
): CallSpec[] =>
  indexes.map((index) => {
    const trace = traces[index];
    if (trace === undefined) throw new Error(`no trace ${String(index)}`);
    return { trace, guaranteed: transcripts[index], ...override?.(index) };
  });

const at = (calls: CallSpec[]) => assembleIntent(chain, emitter, expected.segment, calls);

beforeAll(async () => {
  chain = new LocalChain();
  emitter = await deployEmitter(chain, SECRET);
  parts = patternParts(3, 21);
  built = await buildPackageTransaction(
    chain.source(),
    configFor(),
    requestFor(emitter, emitterBinding(SECRET), parts),
  );
  const [first] = built.packages;
  if (first === undefined) throw new Error("no package");
  expected = first;
  transcripts = transcriptsAt(built.transaction, expected.segment);
  traces = await Promise.all(
    parts.map((part) => traceOf(chain, emitter, emitterBinding(SECRET), part)),
  );
});

describe("failure stages without proofs", () => {
  it("control: the re-assembled all-guaranteed intent passes every stage", () => {
    const result = run(at(specs([0, 1, 2])));
    expect(result.guard).toBe("accepted");
    expect(result.applied).toBe("success");
    expect(result.read?.packages[0]?.parts).toEqual(parts);
    expect(result.raw?.verified).toHaveLength(1);
  });

  it.each([1, 2])(
    "a failing guaranteed part (%i out of gas): the transaction is not included, zero events, state unchanged",
    (bad) => {
      const result = run(
        at(
          specs([0, 1, 2], (index) =>
            index === bad ? { guaranteed: starve(transcripts[index] as Transcript) } : {},
          ),
        ),
      );
      expect(result.guard).toMatch(/call \d guaranteed transcript changed since assembly/);
      expect(result.applied).toBe("failure");
      expect(result.events).toBe(0);
      expect(result.stateUnchanged).toBe(true);
      expect(result.read?.packages).toEqual([]);
      expect(result.raw?.issues.join()).toMatch(/status FAILURE is not an inclusion/);
      expect(result.raw?.verified).toHaveLength(0);
    },
  );

  it("a fallible part before guaranteed parts dies at wellFormed (ordering rule)", () => {
    const result = run(
      at([
        ...specs([0], () => ({ guaranteed: undefined, fallible: transcripts[0] })),
        ...specs([1, 2]),
      ]),
    );
    expect(result.guard).toMatch(/call 1 has a fallible transcript/);
    expect(result.wellFormed).toMatch(/causality/i);
    expect(result.events).toBe(0);
  });

  it("a succeeding fallible last part: the ledger applies it; the publisher and the placement check refuse it", () => {
    const result = run(
      at([
        ...specs([0, 1]),
        ...specs([2], () => ({ guaranteed: undefined, fallible: transcripts[2] })),
      ]),
    );
    expect(result.guard).toMatch(/call 3 has a fallible transcript/);
    expect(result.applied).toBe("success");
    expect(result.events).toBe(3);
    // The events alone look like a normal package; the raw transaction shows the placement.
    expect(result.read?.packages[0]?.parts).toHaveLength(3);
    expect(result.raw?.packages[0]?.placement.join()).toMatch(
      /call 2 of emitPart is not guaranteed-only \(fallible transcript\)/,
    );
    expect(result.raw?.verified).toHaveLength(0);
  });

  it("a failing fallible last part gives partialSuccess with two events: not verified", () => {
    const result = run(
      at([
        ...specs([0, 1]),
        ...specs([2], () => ({
          guaranteed: undefined,
          fallible: starve(transcripts[2] as Transcript),
        })),
      ]),
    );
    expect(result.applied).toBe("partialSuccess");
    expect(result.events).toBe(2);
    expect(result.read?.packages[0]?.parts).toHaveLength(2);
    expect(result.raw?.verified).toHaveLength(0);
  });

  it("one event byte changed after partitioning: the publisher refuses; the placement check agrees with the events", () => {
    const result = run(
      at(
        specs([0, 1, 2], (index) =>
          index === 1 ? { guaranteed: tamperTranscript(transcripts[1] as Transcript) } : {},
        ),
      ),
    );
    expect(result.guard).toMatch(/call 2 emits bytes other than part 2/);
    expect(result.applied).toBe("success");
    // The rule carries no checksum: the merged payload is what was emitted; payload
    // integrity is the adopting protocol's.
    expect(result.read?.packages[0]?.parts[1]).not.toEqual(parts[1]);
    expect(result.raw?.verified[0]?.payload).toEqual(result.read?.packages[0]?.payload);
  });

  it("a dropped, a repeated or a reordered part: the publisher refuses before any proof", () => {
    expect(run(at(specs([0, 1]))).guard).toMatch(/has 2 actions, expected 3/);
    expect(run(at(specs([0, 1, 2, 0]))).guard).toMatch(/has 4 actions, expected 3/);
    const reordered = run(at(specs([2, 0, 1])));
    expect(reordered.guard).toMatch(/call 1 emits bytes other than part 1/);
    // Readers merge in call order: the reordered package is a different payload.
    expect(reordered.read?.packages[0]?.parts).toEqual([parts[2], parts[0], parts[1]]);
  });

  it("an included intent cannot be included again (replay): the second application fails", () => {
    const fork = chain.fork();
    const tx = built.transaction.eraseProofs();
    expect(fork.apply(tx).type).toBe("success");
    let again: string;
    try {
      const result = fork.apply(tx);
      again = `${result.type}: ${String(result.error)}`;
    } catch (error) {
      again = `refused: ${error instanceof Error ? error.message : String(error)}`;
    }
    // The second application fails (not included): the intent already exists.
    expect(again).toMatch(/^failure: .*replay protection.*IntentAlreadyExists/);
  });
});
