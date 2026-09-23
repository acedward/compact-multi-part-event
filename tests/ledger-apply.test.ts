/**
 * Offline ledger application (ported from the soundness audit, B2): publications
 * built by the composer through the injected binding are applied to a local
 * ledger-v9 state with proofs erased. Checks: success, exactly N `emitPart` logs in
 * call order, raw-transaction extraction equal to the applied events, wallet-free
 * verification accepting the publication, unchanged contract state, replay in two
 * transactions, and a 46-part construction.
 */
import type * as ledger from "@midnightntwrk/ledger-v9";
import { beforeAll, describe, expect, it } from "vitest";

import {
  encodePublication,
  eventValueFor,
  ReadStatus,
  readPublications,
} from "../src/codec/index.js";
import {
  extractEmissions,
  publicEventsFromLedgerEvents,
  statusFromLedgerResult,
  verifyPublicationTransaction,
} from "../src/codec/raw-transaction.js";
import { blockFullnessCheck, buildPublicationTransaction } from "../src/transaction/index.js";
import { filled32, patternMessage, toHex } from "./helpers/bytes.js";
import { configFor, deployEmitter, emitterBinding, LocalChain, NETWORK } from "./helpers/ledger.js";

const SECRET = filled32(0x5a);
const WIDE = { maxMessageBytes: 64 * 208, maxParts: 64 };

let chain: LocalChain;
let emitter: string;

beforeAll(async () => {
  chain = new LocalChain();
  emitter = await deployEmitter(chain, SECRET);
});

const target = () => ({ emitter, entryPoint: "emitPart" });

describe("offline ledger application of composed publications", () => {
  it("installs the reference emitter with the committed verifier key", () => {
    const operation = chain.state.index(emitter)?.operation("emitPart");
    expect(operation?.verifierKey.byteLength).toBe(2121);
  });

  it.each([
    { parts: 1, length: 0 },
    { parts: 1, length: 100 },
    { parts: 2, length: 300 },
    { parts: 3, length: 417 },
    { parts: 8, length: 1600 },
    { parts: 8, length: 1664 },
  ])(
    "N=$parts (L=$length): success, N ordered logs, extraction = events, verified",
    async ({ parts, length }) => {
      const message = patternMessage(length);
      const publication = encodePublication(message, WIDE);
      expect(publication.parts).toHaveLength(parts);
      const before = chain.state.index(emitter)?.serialize();

      const built = await buildPublicationTransaction(
        chain.source(),
        emitterBinding(SECRET),
        configFor(emitter),
        publication,
      );
      const erased = built.transaction.eraseProofs();
      const result = chain.apply(erased);
      expect(result.type, String(result.error)).toBe("success");
      expect(result.events).toHaveLength(parts);

      const fromEvents = publicEventsFromLedgerEvents(result.events, {
        ...target(),
        network: NETWORK,
      });
      expect(fromEvents.issues).toEqual([]);
      expect(fromEvents.events).toHaveLength(parts);
      fromEvents.events.forEach((event, index) => {
        const part = publication.parts[index];
        if (part === undefined) throw new Error("no part");
        expect(Uint8Array.from([...event.name, ...event.payload])).toEqual(
          eventValueFor(publication.requestId, part.tail),
        );
      });

      const extraction = extractEmissions(erased, target());
      expect(extraction.transactionIssues).toEqual([]);
      expect(
        extraction.emissions.map((emission) =>
          toHex(Uint8Array.from([...emission.name, ...emission.payload])),
        ),
      ).toEqual(
        fromEvents.events.map((event) => toHex(Uint8Array.from([...event.name, ...event.payload]))),
      );
      expect(new Set(extraction.emissions.map((emission) => emission.segment))).toEqual(
        new Set([built.expected.segment]),
      );

      const report = verifyPublicationTransaction(erased.serialize(), {
        ...target(),
        network: NETWORK,
        status: statusFromLedgerResult(result.type),
        transactionHash: result.events[0]?.source.transactionHash ?? "",
      });
      expect(report.issues).toEqual([]);
      expect(report.accepted).toHaveLength(1);
      expect(report.accepted[0]?.message).toEqual(message);
      expect(report.accepted[0]?.scope.requestIdHex).toBe(toHex(publication.requestId));

      // Stateless emission: the contract state is byte-identical afterwards.
      expect(chain.state.index(emitter)?.serialize()).toEqual(before);
    },
  );

  it("records the emitPart transcript: one read of the sealed authority, then the event", async () => {
    const built = await buildPublicationTransaction(
      chain.source(),
      emitterBinding(SECRET),
      configFor(emitter),
      encodePublication(new Uint8Array()),
    );
    const program = built.frozenTranscripts[0]?.program ?? [];
    expect(program.map((op) => (typeof op === "string" ? op : Object.keys(op)[0]))).toEqual([
      "dup",
      "idx",
      "popeq",
      "push",
      "log",
    ]);
  });

  it("keeps the same publication in two transactions as two complete publications", async () => {
    const publication = encodePublication(patternMessage(417, 5));
    const first = await buildPublicationTransaction(
      chain.source(),
      emitterBinding(SECRET),
      configFor(emitter),
      publication,
    );
    const firstResult = chain.apply(first.transaction.eraseProofs());
    const second = await buildPublicationTransaction(
      chain.source(),
      emitterBinding(SECRET),
      configFor(emitter),
      publication,
    );
    const secondResult = chain.apply(second.transaction.eraseProofs());
    expect([firstResult.type, secondResult.type]).toEqual(["success", "success"]);
    const events = [
      ...publicEventsFromLedgerEvents(firstResult.events, { ...target(), network: NETWORK }).events,
      ...publicEventsFromLedgerEvents(secondResult.events, { ...target(), network: NETWORK })
        .events,
    ];
    const { results } = readPublications([...events].reverse());
    expect(results.map((entry) => entry.status)).toEqual([
      ReadStatus.Complete,
      ReadStatus.Complete,
    ]);
    expect(new Set(results.map((entry) => entry.scope.requestIdHex)).size).toBe(1);
    expect(new Set(results.map((entry) => entry.scope.transactionId)).size).toBe(2);
  });

  it("stores trimmed values: the final part's atom is short and needs width restoration", async () => {
    const built = await buildPublicationTransaction(
      chain.source(),
      emitterBinding(SECRET),
      configFor(emitter),
      encodePublication(patternMessage(417)),
    );
    const result = chain.apply(built.transaction.eraseProofs());
    const atoms = result.events.map((event) => {
      const content = event.content as Extract<ledger.EventDetails, { tag: "contractLog" }>;
      return content.loggedItem.data.tag === "cell"
        ? (content.loggedItem.data.content.value[0]?.byteLength ?? -1)
        : -1;
    });
    expect(atoms).toEqual([288, 288, 81]);
  });

  it("46 parts assemble guaranteed-only, apply and verify with proofs erased", async () => {
    const message = patternMessage(46 * 208, 9);
    const publication = encodePublication(message, WIDE);
    const built = await buildPublicationTransaction(
      chain.source(),
      emitterBinding(SECRET),
      configFor(emitter, { maxParts: 46 }),
      publication,
    );
    const erased = built.transaction.eraseProofs();
    const params = chain.state.parameters;
    // Construction and application only. Before proving, the ledger estimates each
    // proof at its maximum size, so the unproven 46-part transaction exceeds that
    // estimate; with real proofs the reference emitter fits 33 parts in one block
    // (tests/real-proof.test.ts, PROVE_LIMIT_AT).
    const preProof = (() => {
      try {
        blockFullnessCheck()(built.transaction, params, "pre-proof estimate");
        return "fits";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    })();
    const result = chain.apply(erased, { enforceLimits: true });
    expect(result.type).toBe("success");
    expect(result.events).toHaveLength(46);
    const report = verifyPublicationTransaction(erased, {
      ...target(),
      network: NETWORK,
      status: statusFromLedgerResult(result.type),
      transactionHash: result.events[0]?.source.transactionHash ?? "",
    });
    expect(report.accepted[0]?.message).toEqual(message);
    console.log(
      `[46-parts] unproven=${String(built.transaction.serialize().byteLength)}B erased=${String(erased.serialize().byteLength)}B preProofCheck=${preProof}`,
    );
  });
});
