/**
 * Offline ledger application (US1): packages built by the publisher through the
 * injected binding are applied to a local ledger-v9 state with proofs erased. Checks:
 * success; exactly k `Misc` events named N with the k payloads in call order, all from
 * the package's intent; the reader's package from those events equals the raw
 * transaction's; unchanged contract state; the same payload again in another
 * transaction is another package; trimmed values; a large package.
 */
import type * as ledger from "@midnightntwrk/ledger-v9";
import { beforeAll, describe, expect, it } from "vitest";

import {
  blockFullnessCheck,
  buildPackagesTransaction,
  buildPackageTransaction,
  splitPayload,
} from "../src/publisher/index.js";
import {
  checkPlacement,
  eventName,
  partEventsFromLedgerEvents,
  readPackages,
  splitEventValue,
  statusFromLedgerResult,
  verifyTransactionPackages,
} from "../src/reader/index.js";
import {
  ascii,
  concatBytes,
  filled32,
  patternMessage,
  patternParts,
  shortPart,
} from "./helpers/bytes.js";
import { EXAMPLE_NAME } from "./helpers/generated.js";
import {
  configFor,
  deployEmitter,
  emitterBinding,
  LocalChain,
  NETWORK,
  requestFor,
} from "./helpers/ledger.js";

const SECRET = filled32(0x5a);

let chain: LocalChain;
let emitter: string;

beforeAll(async () => {
  chain = new LocalChain();
  emitter = await deployEmitter(chain, SECRET);
});

const publish = async (parts: readonly Uint8Array[], maxParts?: number) => {
  const built = await buildPackageTransaction(
    chain.source(),
    configFor(maxParts === undefined ? {} : { maxParts }),
    requestFor(emitter, emitterBinding(SECRET), parts),
  );
  const erased = built.transaction.eraseProofs();
  const result = chain.apply(erased);
  return { built, erased, result };
};

const optIns = () => [{ contract: emitter, name: EXAMPLE_NAME }];
const target = () => ({ contract: emitter, entryPoint: "emitPart", name: EXAMPLE_NAME });

describe("offline ledger application of published packages", () => {
  it("installs the reference emitter with the committed verifier key", () => {
    const operation = chain.state.index(emitter)?.operation("emitPart");
    expect(operation?.verifierKey.byteLength).toBeGreaterThan(0);
  });

  it.each([1, 2, 8])(
    "k=%i: success, k events named N with the k payloads in order, one package, verified from the raw transaction",
    async (count) => {
      const parts = patternParts(count, count);
      const before = chain.state.index(emitter)?.serialize();
      const { built, erased, result } = await publish(parts);
      expect(result.type, String(result.error)).toBe("success");
      const segment = built.packages[0]?.segment;

      // The events: k Misc events of the emitter, named N, payloads in call order, all
      // from the package's intent.
      expect(result.events).toHaveLength(count);
      const converted = partEventsFromLedgerEvents(result.events, { network: NETWORK });
      expect(converted.issues).toEqual([]);
      converted.events.forEach((event, index) => {
        const { name, payload } = splitEventValue(event.value);
        expect(event.contract).toBe(emitter);
        expect(event.segment).toBe(segment);
        expect(name).toEqual(eventName(EXAMPLE_NAME));
        expect(payload).toEqual(parts[index]);
      });
      expect(result.events.map((event) => event.source.logicalSegment)).toEqual(
        Array.from({ length: count }, () => 0),
      );

      // The reader: one package, the merged payload.
      const { packages } = readPackages(converted.events, { optIns: optIns() });
      expect(packages).toHaveLength(1);
      expect(packages[0]?.status).toBe("accepted");
      expect(packages[0]?.segment).toBe(segment);
      expect(packages[0]?.payload).toEqual(concatBytes(parts));

      // The raw transaction: the same package, guaranteed-only placement.
      const verification = verifyTransactionPackages(erased.serialize(), {
        ...target(),
        network: NETWORK,
        status: statusFromLedgerResult(result.type),
        transactionHash: result.events[0]?.source.transactionHash ?? "",
      });
      expect(verification.issues).toEqual([]);
      expect(verification.packages.map((entry) => entry.placement)).toEqual([[]]);
      expect(verification.verified).toHaveLength(1);
      expect(verification.verified[0]?.payload).toEqual(packages[0]?.payload);
      expect(verification.verified[0]?.transactionHash).toBe(packages[0]?.transactionHash);

      // Stateless emission: the contract state is byte-identical afterwards.
      expect(chain.state.index(emitter)?.serialize()).toEqual(before);
    },
  );

  it("records the emitPart transcript: one read of the sealed authority, then the event", async () => {
    const built = await buildPackageTransaction(
      chain.source(),
      configFor(),
      requestFor(emitter, emitterBinding(SECRET), patternParts(1)),
    );
    const program = built.frozenTranscripts[0]?.[0]?.program ?? [];
    expect(program.map((op) => (typeof op === "string" ? op : Object.keys(op)[0]))).toEqual([
      "dup",
      "idx",
      "popeq",
      "push",
      "log",
    ]);
  });

  it("the same payload in two transactions is two packages with equal payloads", async () => {
    const parts = splitPayload(patternMessage(700, 5));
    const first = await publish(parts);
    const second = await publish(parts);
    expect([first.result.type, second.result.type]).toEqual(["success", "success"]);
    const events = [
      ...partEventsFromLedgerEvents(first.result.events, { network: NETWORK }).events,
      ...partEventsFromLedgerEvents(second.result.events, { network: NETWORK }).events,
    ];
    const { packages } = readPackages([...events].reverse(), { optIns: optIns() });
    expect(packages.map((pkg) => pkg.status)).toEqual(["accepted", "accepted"]);
    expect(new Set(packages.map((pkg) => pkg.transactionHash)).size).toBe(2);
    expect(packages[0]?.payload).toEqual(packages[1]?.payload);
  });

  it("stores trimmed values: a part ending in zeros arrives short and is restored", async () => {
    const parts = [patternParts(1, 3)[0] as Uint8Array, shortPart(ascii("last part"))];
    const { result } = await publish(parts);
    const atoms = result.events.map((event) => {
      const content = event.content as Extract<ledger.EventDetails, { tag: "contractLog" }>;
      return content.loggedItem.data.tag === "cell"
        ? (content.loggedItem.data.content.value[0]?.byteLength ?? -1)
        : -1;
    });
    expect(atoms[1]).toBe(32 + 9);
    const { packages } = readPackages(
      partEventsFromLedgerEvents(result.events, { network: NETWORK }).events,
      {
        optIns: optIns(),
      },
    );
    expect(packages[0]?.parts).toEqual(parts);
  });

  it("a 64-part package assembles guaranteed-only, applies and verifies with proofs erased", async () => {
    const parts = patternParts(64, 9);
    const { built, erased, result } = await publish(parts, 64);
    // Construction and application only. Before proving, the ledger estimates each proof
    // at its maximum size, so the unproven transaction's cost is an overestimate; the
    // block fit with real proofs is measured separately (tests/real-proof.test.ts).
    const preProof = (() => {
      try {
        blockFullnessCheck()(built.transaction, chain.state.parameters, "pre-proof estimate");
        return "fits";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    })();
    expect(result.type).toBe("success");
    expect(result.events).toHaveLength(64);
    const verification = verifyTransactionPackages(erased, {
      ...target(),
      network: NETWORK,
      status: statusFromLedgerResult(result.type),
      transactionHash: result.events[0]?.source.transactionHash ?? "",
    });
    expect(verification.verified[0]?.payload).toEqual(concatBytes(parts));
    console.log(
      `[64-parts] unproven=${String(built.transaction.serialize().byteLength)}B erased=${String(erased.serialize().byteLength)}B preProofCheck=${preProof}`,
    );
  });
});

describe("placement from the raw transaction (the Level 2 core)", () => {
  it("several packages from the publisher in one transaction: one package per intent, each placement clean", async () => {
    const first = patternParts(2, 70);
    const second = patternParts(3, 71);
    const built = await buildPackagesTransaction(chain.source(), configFor(), [
      requestFor(emitter, emitterBinding(SECRET), first),
      requestFor(emitter, emitterBinding(SECRET), second),
    ]);
    const erased = built.transaction.eraseProofs();
    const result = chain.apply(erased);
    expect(result.type).toBe("success");
    const { packages } = readPackages(
      partEventsFromLedgerEvents(result.events, { network: NETWORK }).events,
      {
        optIns: optIns(),
      },
    );
    expect(packages).toHaveLength(2);
    const bySegment = new Map(packages.map((pkg) => [pkg.segment, pkg]));
    expect(bySegment.get(built.packages[0]?.segment ?? 0)?.payload).toEqual(concatBytes(first));
    expect(bySegment.get(built.packages[1]?.segment ?? 0)?.payload).toEqual(concatBytes(second));
    for (const pkg of packages) expect(checkPlacement(erased, target(), pkg)).toEqual([]);
  });

  it("an incomplete fetch, a differing part and a wrong segment are placement failures", async () => {
    const parts = patternParts(3, 72);
    const { erased, result } = await publish(parts);
    const events = partEventsFromLedgerEvents(result.events, { network: NETWORK }).events;
    const [full] = readPackages(events, { optIns: optIns() }).packages;
    if (full === undefined) throw new Error("no package");
    expect(checkPlacement(erased, target(), full)).toEqual([]);
    // A paging reader that missed the last event merges two parts: Level 2 sees three calls.
    const [partial] = readPackages(events.slice(0, 2), { optIns: optIns() }).packages;
    expect(partial?.status).toBe("accepted");
    expect(checkPlacement(erased, target(), partial ?? full)).toEqual([
      "the intent's emitPart calls log 3 parts; the package has 2",
    ]);
    expect(checkPlacement(erased, target(), { ...full, parts: [...full.parts].reverse() })).toEqual(
      ["part 1 differs from what call 1 logs", "part 3 differs from what call 3 logs"],
    );
    const elsewhere = full.segment === 65535 ? 1 : full.segment + 1;
    expect(checkPlacement(erased, target(), { ...full, segment: elsewhere })).toEqual([
      `no intent at segment ${String(elsewhere)}`,
    ]);
    // Another name in the configuration: the calls log no part under it.
    expect(checkPlacement(erased, { ...target(), name: "example:other[v1]" }, full)).toEqual([
      "the intent's emitPart calls log 0 parts; the package has 3",
    ]);
  });
});
