/**
 * Strangers and merges (US2 scenarios 1 and 2, edge cases), offline with erased proofs:
 * - on the test-only open emitter a stranger merges an intent of their own, at a lower
 *   or a higher segment, emitting the SAME name under the SAME contract: each intent is
 *   its own package and mine is unchanged;
 * - a stranger cannot take my segment: the ledger refuses the merge, sealed or not;
 * - on the access-controlled reference emitter a stranger cannot produce a part at all;
 * - two of my packages merged into one transaction are two packages;
 * - a foreign contract's intent, or a failing foreign fallible segment (PARTIAL_SUCCESS),
 *   does not change my package;
 * - a merged transaction is located by the package's identifiers and intent, not its hash.
 */
import * as ledger from "@midnightntwrk/ledger-v9";
import { beforeAll, describe, expect, it } from "vitest";

import {
  assertPackageIntent,
  buildPackageTransaction,
  type BuiltTransaction,
  finalizeTransactionPackages,
  locateRecord,
} from "../src/publisher/index.js";
import {
  type AnyTransaction,
  partEventsFromLedgerEvents,
  readPackages,
  statusFromLedgerResult,
  verifyTransactionPackages,
} from "../src/reader/index.js";
import { concatBytes, filled32, patternParts } from "./helpers/bytes.js";
import { EXAMPLE_NAME } from "./helpers/generated.js";
import {
  configFor,
  deployEmitter,
  deployOpenEmitter,
  emitterBinding,
  guaranteedTranscript,
  assembleIntent,
  intentAt,
  LocalChain,
  NETWORK,
  openBinding,
  requestFor,
  starve,
  traceOf,
} from "./helpers/ledger.js";

const OURS = filled32(0x71);
const FOREIGN = filled32(0x72);
let chain: LocalChain;
let emitter: string;
let foreignEmitter: string;
let open: string;

/** A package build whose segment leaves room below and above it. */
const buildMine = async (
  contract: string,
  parts: readonly Uint8Array[],
  secret?: Uint8Array,
): Promise<BuiltTransaction> => {
  for (;;) {
    const built = await buildPackageTransaction(
      chain.source(),
      configFor(),
      secret === undefined
        ? requestFor(contract, openBinding(), parts)
        : requestFor(contract, emitterBinding(secret), parts),
    );
    const segment = built.packages[0]?.segment ?? 0;
    if (segment > 2 && segment < 65533) return built;
  }
};

const applyOnFork = (tx: AnyTransaction) => {
  const fork = chain.fork();
  const erased = tx.eraseProofs();
  return { erased, result: fork.apply(erased) };
};

const readFrom = (result: ledger.TransactionResult, contract: string) =>
  readPackages(partEventsFromLedgerEvents(result.events, { network: NETWORK }).events, {
    optIns: [{ contract, name: EXAMPLE_NAME }],
  });

const verifyRaw = (
  tx: AnyTransaction,
  result: ledger.TransactionResult,
  contract: string,
  status?: string,
) =>
  verifyTransactionPackages(tx, {
    contract,
    entryPoint: "emitPart",
    name: EXAMPLE_NAME,
    network: NETWORK,
    status: status ?? statusFromLedgerResult(result.type),
    transactionHash: result.events[0]?.source.transactionHash ?? "",
  });

beforeAll(async () => {
  chain = new LocalChain();
  emitter = await deployEmitter(chain, OURS);
  foreignEmitter = await deployEmitter(chain, FOREIGN);
  open = await deployOpenEmitter(chain);
});

describe("a stranger's intent under the same contract and name (open emitter)", () => {
  it.each([
    ["lower", -2],
    ["higher", +2],
  ])("at a %s segment: two packages, one per intent; mine is unchanged", async (_, offset) => {
    const mineParts = patternParts(3, 1);
    const strangerParts = patternParts(2, 2);
    const mine = await buildMine(open, mineParts);
    const expected = mine.packages[0];
    if (expected === undefined) throw new Error("no package");
    const strangerSegment = expected.segment + offset;
    const stranger = await intentAt(chain, open, openBinding(), strangerSegment, strangerParts);
    const merged = mine.transaction.merge(stranger);
    expect(merged.intents?.size).toBe(2);

    // The publisher's check looks only at my intent, so the merge passes.
    expect(() => {
      assertPackageIntent(merged, expected, "merged", mine.frozenTranscripts[0]);
    }).not.toThrow();

    const { erased, result } = applyOnFork(merged);
    expect(result.type).toBe("success");
    expect(result.events).toHaveLength(5);
    // The ledger applies intents in ascending segment order.
    const segments = result.events.map((event) => event.source.physicalSegment);
    expect(segments).toEqual(
      offset < 0
        ? [strangerSegment, strangerSegment, expected.segment, expected.segment, expected.segment]
        : [expected.segment, expected.segment, expected.segment, strangerSegment, strangerSegment],
    );

    const { packages } = readFrom(result, open);
    expect(packages.map((pkg) => [pkg.segment, pkg.parts.length, pkg.status])).toEqual(
      [
        [expected.segment, 3, "accepted"],
        [strangerSegment, 2, "accepted"],
      ].sort((left, right) => (left[0] as number) - (right[0] as number)),
    );
    const minePackage = packages.find((pkg) => pkg.segment === expected.segment);
    expect(minePackage?.payload).toEqual(concatBytes(mineParts));
    expect(packages.find((pkg) => pkg.segment === strangerSegment)?.payload).toEqual(
      concatBytes(strangerParts),
    );

    // Level 2: my package's placement holds; the stranger's is a separate package.
    const raw = verifyRaw(erased, result, open);
    expect(raw.issues).toEqual([]);
    expect(raw.verified.map((pkg) => pkg.segment).sort((a, b) => a - b)).toEqual(
      [expected.segment, strangerSegment].sort((a, b) => a - b),
    );
    expect(raw.verified.find((pkg) => pkg.segment === expected.segment)?.payload).toEqual(
      minePackage?.payload,
    );
  });

  it("a stranger cannot take my segment: the merge is refused, sealed or not", async () => {
    const mine = await buildMine(open, patternParts(2, 3));
    const segment = mine.packages[0]?.segment ?? 0;
    const stranger = await intentAt(chain, open, openBinding(), segment, patternParts(1, 4));
    expect(() => mine.transaction.merge(stranger)).toThrow(/collision/);
    expect(() => mine.transaction.bind().merge(stranger.bind())).toThrow(/collision/);
  });

  it("a sealed intent cannot take more calls", async () => {
    const mine = await buildMine(open, patternParts(1, 5));
    const segment = mine.packages[0]?.segment ?? 0;
    const trace = await traceOf(chain, open, openBinding(), patternParts(1, 6)[0] as Uint8Array);
    const extra = assembleIntent(chain, open, segment, [
      { trace, guaranteed: guaranteedTranscript(chain, trace) },
    ]).intents?.get(segment);
    if (extra === undefined) throw new Error("no intent");
    expect(() =>
      mine.transaction.bind().addIntent({ tag: "specific", value: segment }, extra as never),
    ).toThrow(/bound/);
  });
});

describe("the access-controlled reference emitter", () => {
  it("a stranger cannot produce a part: execution fails before any transaction exists", async () => {
    await expect(
      buildPackageTransaction(
        chain.source(),
        configFor(),
        requestFor(emitter, emitterBinding(FOREIGN), patternParts(1, 7)),
      ),
    ).rejects.toThrow(/caller is not the emitter authority/);
  });

  it("two of my packages merged into one transaction are two packages, one per intent", async () => {
    const firstParts = patternParts(3, 8);
    const secondParts = patternParts(1, 9);
    const first = await buildMine(emitter, firstParts, OURS);
    let second = await buildMine(emitter, secondParts, OURS);
    while (second.packages[0]?.segment === first.packages[0]?.segment) {
      second = await buildMine(emitter, secondParts, OURS);
    }
    const merged = first.transaction.merge(second.transaction);
    for (const built of [first, second]) {
      const expected = built.packages[0];
      if (expected === undefined) throw new Error("no package");
      expect(() => {
        assertPackageIntent(merged, expected, "merged");
      }).not.toThrow();
    }
    const { erased, result } = applyOnFork(merged);
    expect(result.type).toBe("success");
    const { packages } = readFrom(result, emitter);
    expect(packages).toHaveLength(2);
    const bySegment = new Map(packages.map((pkg) => [pkg.segment, pkg.payload]));
    expect(bySegment.get(first.packages[0]?.segment ?? 0)).toEqual(concatBytes(firstParts));
    expect(bySegment.get(second.packages[0]?.segment ?? 0)).toEqual(concatBytes(secondParts));
    expect(verifyRaw(erased, result, emitter).verified).toHaveLength(2);
  });

  it("a foreign contract's intent does not change my package", async () => {
    const parts = patternParts(3, 10);
    const ours = await buildMine(emitter, parts, OURS);
    let foreign = await buildMine(foreignEmitter, patternParts(2, 11), FOREIGN);
    while (foreign.packages[0]?.segment === ours.packages[0]?.segment) {
      foreign = await buildMine(foreignEmitter, patternParts(2, 11), FOREIGN);
    }
    const merged = ours.transaction.merge(foreign.transaction);
    const { erased, result } = applyOnFork(merged);
    expect(result.events).toHaveLength(5);
    const { packages, ignored } = readFrom(result, emitter);
    expect(ignored).toBe(2); // the foreign contract's events, left untouched
    expect(packages).toHaveLength(1);
    expect(packages[0]?.payload).toEqual(concatBytes(parts));
    const raw = verifyRaw(erased, result, emitter);
    expect(raw.issues).toEqual([]);
    expect(raw.verified).toHaveLength(1);
  });

  it("a failing foreign fallible segment gives PARTIAL_SUCCESS; my package is still verified", async () => {
    const parts = patternParts(2, 12);
    const ours = await buildMine(emitter, parts, OURS);
    const segment = ours.packages[0]?.segment ?? 0;
    const foreignSegment = segment < 65535 ? segment + 1 : segment - 1;
    const trace = await traceOf(
      chain,
      foreignEmitter,
      emitterBinding(FOREIGN),
      patternParts(1, 13)[0] as Uint8Array,
    );
    const failing = assembleIntent(chain, foreignEmitter, foreignSegment, [
      { trace, fallible: starve(guaranteedTranscript(chain, trace)) },
    ]);
    const { erased, result } = applyOnFork(ours.transaction.merge(failing));
    expect(result.type).toBe("partialSuccess");
    expect(result.events).toHaveLength(2);
    const raw = verifyRaw(erased, result, emitter);
    expect(raw.issues).toEqual([]);
    expect(raw.verified[0]?.payload).toEqual(concatBytes(parts));
    // FAILURE never lands on chain; if a source reported it, nothing is verified.
    expect(verifyRaw(erased, result, emitter, "FAILURE").verified).toHaveLength(0);
  });

  it("a merged transaction is located by the package's identifiers and intent, not its hash", async () => {
    const ours = await buildMine(emitter, patternParts(2, 14), OURS);
    const record = await finalizeTransactionPackages(
      {
        prover: { proveTx: (tx) => Promise.resolve(tx as never) },
        balancer: {
          balanceTx: (tx) =>
            Promise.resolve((tx as unknown as ledger.UnprovenTransaction).bind() as never),
        },
      },
      ours,
      { proofTimeoutMs: 1000, requireProofs: false },
    );
    const bound = ledger.Transaction.deserialize(
      "signature",
      "pre-proof",
      "binding",
      Buffer.from(record.transactionHex, "hex"),
    );
    const segment = ours.packages[0]?.segment ?? 0;
    const stranger = (
      await intentAt(
        chain,
        open,
        openBinding(),
        segment < 65535 ? segment + 1 : segment - 1,
        patternParts(1, 15),
      )
    ).bind();
    const merged = bound.merge(stranger);
    expect(locateRecord(bound, record)).toEqual({ contains: true, merged: false });
    expect(locateRecord(merged, record)).toEqual({ contains: true, merged: true });
    const other = await buildMine(emitter, patternParts(2, 16), OURS);
    expect(locateRecord(other.transaction.bind(), record).contains).toBe(false);
  });
});
