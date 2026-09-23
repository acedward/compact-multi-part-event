/**
 * Where a bad publication dies (ported from the soundness audit, B4 proof-free half).
 * Calls are re-assembled from real compiled-circuit traces and the composer's own
 * partitioned transcripts, so only the property under test differs from a genuine
 * publication. Each case reports the real stage: publisher check (before any proof),
 * `wellFormed`, `apply`, or the wallet-free verifier.
 */
import type { CallProofData } from "@midnight-ntwrk/compact-runtime";
import * as ledger from "@midnightntwrk/ledger-v9";
import { beforeAll, describe, expect, it } from "vitest";

import { encodePublication, type EncodedPublication, ReadStatus } from "../src/codec/index.js";
import {
  statusFromLedgerResult,
  verifyPublicationTransaction,
} from "../src/codec/raw-transaction.js";
import {
  assertPublicationIntent,
  buildPublicationTransaction,
  type BuiltPublication,
} from "../src/transaction/index.js";
import { filled32, patternMessage } from "./helpers/bytes.js";
import {
  assembleIntent,
  type CallSpec,
  configFor,
  deployEmitter,
  emitterBinding,
  emitterTrace,
  LocalChain,
  NETWORK,
  starve,
  tamperTranscript,
  transcriptsAt,
} from "./helpers/ledger.js";

type Transcript = ledger.Transcript<ledger.AlignedValue>;

const SECRET = filled32(0x61);
let chain: LocalChain;
let emitter: string;
let publication: EncodedPublication;
let built: BuiltPublication;
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

/** Publisher check, then wellFormed + apply on a fork, then the wallet-free verifier. */
const run = (tx: ledger.UnprovenTransaction, segment = built.expected.segment) => {
  const guard = outcome(() => {
    assertPublicationIntent(tx, { ...built.expected, segment }, "test", built.frozenTranscripts);
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
  if (verified === undefined)
    return { guard, wellFormed, applied: "not applied", events: 0, report: undefined };
  const before = fork.state.serialize();
  const [after, result] = fork.state.apply(
    verified,
    new ledger.TransactionContext(fork.state, fork.blockContext()),
  );
  const report = verifyPublicationTransaction(erased, {
    emitter,
    entryPoint: "emitPart",
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
    report,
  };
};

const specs = (
  parts: readonly number[],
  override?: (part: number) => Partial<CallSpec>,
): CallSpec[] =>
  parts.map((part) => {
    const trace = traces[part];
    if (trace === undefined) throw new Error(`no trace ${String(part)}`);
    return { trace, guaranteed: transcripts[part], ...override?.(part) };
  });

beforeAll(async () => {
  chain = new LocalChain();
  emitter = await deployEmitter(chain, SECRET);
  publication = encodePublication(patternMessage(417, 21));
  built = await buildPublicationTransaction(
    chain.source(),
    emitterBinding(SECRET),
    configFor(emitter),
    publication,
  );
  transcripts = transcriptsAt(built.transaction, built.expected.segment);
  traces = await Promise.all(
    publication.parts.map((part) =>
      emitterTrace(chain, emitter, SECRET, publication.requestId, part.tail),
    ),
  );
});

describe("failure stages without proofs", () => {
  it("control: the re-assembled all-guaranteed intent passes every stage", () => {
    const result = run(assembleIntent(chain, emitter, built.expected.segment, specs([0, 1, 2])));
    expect(result.guard).toBe("accepted");
    expect(result.applied).toBe("success");
    expect(result.report?.accepted).toHaveLength(1);
  });

  it("(c1) a fallible part before guaranteed parts dies at wellFormed (ordering rule)", () => {
    const result = run(
      assembleIntent(chain, emitter, built.expected.segment, [
        ...specs([0], () => ({ guaranteed: undefined, fallible: transcripts[0] })),
        ...specs([1, 2]),
      ]),
    );
    expect(result.guard).toMatch(/call 1 has a fallible transcript/);
    expect(result.wellFormed).toMatch(/causality/i);
    expect(result.events).toBe(0);
  });

  it("(c1b) a succeeding fallible last part: the ledger applies it, the publisher check and the verifier refuse it", () => {
    const result = run(
      assembleIntent(chain, emitter, built.expected.segment, [
        ...specs([0, 1]),
        ...specs([2], () => ({ guaranteed: undefined, fallible: transcripts[2] })),
      ]),
    );
    expect(result.guard).toMatch(/call 3 has a fallible transcript/);
    expect(result.applied).toBe("success");
    expect(result.events).toBe(3);
    expect(result.report?.accepted).toHaveLength(0);
    expect(result.report?.read.results[0]?.status).toBe(ReadStatus.Rejected);
    expect(result.report?.read.results[0]?.issues.join()).toMatch(/fallible transcript/);
  });

  it("(c2b) a failing fallible last part gives partialSuccess with two events: not accepted", () => {
    const result = run(
      assembleIntent(chain, emitter, built.expected.segment, [
        ...specs([0, 1]),
        ...specs([2], () => ({
          guaranteed: undefined,
          fallible: starve(transcripts[2] as Transcript),
        })),
      ]),
    );
    expect(result.applied).toBe("partialSuccess");
    expect(result.events).toBe(2);
    expect(result.report?.accepted).toHaveLength(0);
  });

  it.each([1, 2])(
    "(c3) guaranteed part %i out of gas: failure, zero events, state unchanged",
    (bad) => {
      const result = run(
        assembleIntent(
          chain,
          emitter,
          built.expected.segment,
          specs([0, 1, 2], (part) =>
            part === bad ? { guaranteed: starve(transcripts[part] as Transcript) } : {},
          ),
        ),
      );
      expect(result.guard).toMatch(/call \d guaranteed transcript changed since assembly/);
      expect(result.applied).toBe("failure");
      expect(result.events).toBe(0);
      expect(result.stateUnchanged).toBe(true);
      expect(result.report?.issues.join()).toMatch(/status FAILURE is not an inclusion/);
      expect(result.report?.accepted).toHaveLength(0);
    },
  );

  it("(a1) one event byte changed after partitioning: publisher check refuses; verifier rejects the hash", () => {
    const result = run(
      assembleIntent(
        chain,
        emitter,
        built.expected.segment,
        specs([0, 1, 2], (part) =>
          part === 1 ? { guaranteed: tamperTranscript(transcripts[1] as Transcript) } : {},
        ),
      ),
    );
    expect(result.guard).toMatch(/call 2 emits bytes other than part 2/);
    expect(result.applied).toBe("success");
    expect(result.report?.read.results[0]?.issues.join()).toMatch(/does not match the request ID/);
    expect(result.report?.accepted).toHaveLength(0);
  });

  it("(d1) a dropped part: publisher check refuses; the verifier sees an incomplete publication", () => {
    const result = run(assembleIntent(chain, emitter, built.expected.segment, specs([0, 1])));
    expect(result.guard).toMatch(/has 2 actions, expected 3/);
    expect(result.report?.read.results[0]?.status).toBe(ReadStatus.Incomplete);
    expect(result.report?.accepted).toHaveLength(0);
  });

  it("(d2) the same part emitted twice: publisher check refuses; the verifier rejects the extra part", () => {
    const result = run(assembleIntent(chain, emitter, built.expected.segment, specs([0, 1, 2, 0])));
    expect(result.guard).toMatch(/has 4 actions, expected 3/);
    expect(result.applied).toBe("success");
    expect(result.report?.read.results[0]?.issues).toContain("part 1 was emitted 2 times");
    expect(result.report?.accepted).toHaveLength(0);
  });

  it("(d3) reordered calls: publisher check refuses (order is part of the expectation)", () => {
    const result = run(assembleIntent(chain, emitter, built.expected.segment, specs([2, 0, 1])));
    expect(result.guard).toMatch(/call 1 emits bytes other than part 1/);
    // Order inside a transaction does not change the message: the reader orders by ppp.
    expect(result.report?.accepted).toHaveLength(1);
  });
});
