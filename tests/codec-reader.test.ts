/**
 * Writer limits, position field, and the reader's grouping, identity, ordering,
 * bounding and adversarial behaviour (spec Edge Cases).
 */
import { describe, expect, it } from "vitest";

import {
  decodeFragment,
  decodePosition,
  encodePosition,
  encodePublication,
  eventNameFor,
  eventPayloadFor,
  FORMAT_MAX_PARTS,
  type PublicEvent,
  readPublications,
  type ReadOutput,
  ReadStatus,
} from "../src/codec/index.js";
import { ascii, patternMessage, toHex } from "./helpers/bytes.js";

const events = (
  message: Uint8Array,
  scope: { network?: string; emitter?: string; transactionId?: string; idPrefix?: string } = {},
): PublicEvent[] => {
  const publication = encodePublication(message);
  return publication.parts.map((part) => ({
    network: scope.network ?? "net",
    emitter: scope.emitter ?? "emitter",
    transactionId: scope.transactionId ?? "tx-1",
    eventId: `${scope.idPrefix ?? "e"}${String(part.position)}`,
    name: eventNameFor(part.tail),
    payload: eventPayloadFor(publication.requestId, part.tail),
  }));
};

const at = <T>(list: readonly T[], index: number): T => {
  const value = list[index];
  if (value === undefined) throw new Error(`no element ${String(index)}`);
  return value;
};

/** Stable, comparable rendering of a reader output. */
const render = (output: ReadOutput): string =>
  JSON.stringify(output, (_, value: unknown) =>
    value instanceof Uint8Array ? `hex:${toHex(value)}` : value,
  );

const permutations = <T>(items: readonly T[]): T[][] => {
  if (items.length <= 1) return [items.slice()];
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
      item,
      ...rest,
    ]),
  );
};

describe("writer", () => {
  it("encodes the empty message as one tail 001:001 with length 0", () => {
    const publication = encodePublication(new Uint8Array());
    expect(publication.parts).toHaveLength(1);
    const tail = at(publication.parts, 0).tail;
    expect(tail.subarray(0, 8)).toEqual(Uint8Array.from([...ascii("001:001"), 0]));
    expect(tail.subarray(8)).toEqual(new Uint8Array(216));
  });

  it("enforces its limits and the 999-part format ceiling", () => {
    expect(() =>
      encodePublication(new Uint8Array(209), { maxMessageBytes: 208, maxParts: 8 }),
    ).toThrow(/exceeds maxMessageBytes/);
    expect(() =>
      encodePublication(new Uint8Array(417), { maxMessageBytes: 1000, maxParts: 2 }),
    ).toThrow(/needs 3 parts/);
    expect(() =>
      encodePublication(new Uint8Array(1), { maxMessageBytes: 10, maxParts: 0 }),
    ).toThrow(/maxParts/);
    expect(() =>
      encodePublication(new Uint8Array(1), { maxMessageBytes: 10, maxParts: FORMAT_MAX_PARTS + 1 }),
    ).toThrow(/maxParts/);
    const max = encodePublication(new Uint8Array(999 * 208), {
      maxMessageBytes: 999 * 208,
      maxParts: 999,
    });
    expect(max.parts).toHaveLength(999);
    expect(at(max.parts, 998).tail.subarray(0, 8)).toEqual(
      Uint8Array.from([...ascii("999:999"), 0]),
    );
  });

  it("encodes and decodes the position field as exactly ppp:nnn", () => {
    for (const [position, total] of [
      [1, 1],
      [9, 10],
      [10, 10],
      [99, 100],
      [999, 999],
    ] as const) {
      expect(decodePosition(encodePosition(position, total))).toEqual({ position, total });
    }
    expect(() => encodePosition(0, 1)).toThrow(RangeError);
    expect(() => encodePosition(2, 1)).toThrow(RangeError);
    expect(() => encodePosition(1, 1000)).toThrow(RangeError);
    expect(encodePosition(1, 10)).toEqual(Uint8Array.from([...ascii("001:010"), 0]));
    expect(encodePosition(46, 46)).toEqual(Uint8Array.from([...ascii("046:046"), 0]));
    expect(() => decodePosition(new Uint8Array(7))).toThrow(/8 bytes/);
    expect(() => decodePosition(Uint8Array.from([...ascii("1:10"), 0, 0, 0, 0]))).toThrow(
      /not three ASCII digits/,
    );
  });

  it("keeps identical messages identical (same request ID in every transaction)", () => {
    const one = encodePublication(patternMessage(500));
    const two = encodePublication(patternMessage(500));
    expect(one.requestId).toEqual(two.requestId);
  });
});

describe("reader grouping and identity", () => {
  it("tolerates redelivery of the same event identity", () => {
    const base = events(patternMessage(417));
    const { results } = readPublications([...base, at(base, 0), at(base, 2)]);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      status: ReadStatus.Complete,
      deliveries: 5,
      receivedParts: 3,
      eventIds: ["e1", "e2", "e3"],
    });
  });

  it("rejects one identity delivered with different contents", () => {
    const base = events(patternMessage(417));
    const altered = {
      ...at(base, 1),
      payload: at(base, 1).payload.map((byte, i) => (i === 100 ? byte ^ 1 : byte)),
    };
    const { results } = readPublications([...base, altered]);
    expect(results[0]?.status).toBe(ReadStatus.Rejected);
    expect(results[0]?.issues).toContain("event e2 was delivered with different contents");
  });

  it("rejects the same part emitted twice (same bytes, two identities) and conflicting parts", () => {
    const base = events(patternMessage(417));
    const twice = readPublications([...base, { ...at(base, 0), eventId: "e9" }]);
    expect(twice.results[0]?.status).toBe(ReadStatus.Rejected);
    expect(twice.results[0]?.issues).toContain("part 1 was emitted 2 times");
    const conflicting = {
      ...at(base, 0),
      eventId: "e9",
      payload: at(base, 0).payload.map((b, i) => (i === 200 ? b ^ 1 : b)),
    };
    const conflict = readPublications([...base, conflicting]);
    expect(conflict.results[0]?.issues).toContain("conflicting data for part 1");
  });

  it("keeps transactions, emitters and networks apart (replay stays two publications)", () => {
    const message = patternMessage(417);
    const one = events(message, { transactionId: "tx-1" });
    const two = events(message, { transactionId: "tx-2" });
    const interleaved = [at(two, 2), at(one, 0), at(two, 0), at(one, 2), at(one, 1), at(two, 1)];
    const { results } = readPublications(interleaved);
    expect(results.map((result) => [result.scope.transactionId, result.status])).toEqual([
      ["tx-1", ReadStatus.Complete],
      ["tx-2", ReadStatus.Complete],
    ]);
    expect(new Set(results.map((result) => result.scope.requestIdHex)).size).toBe(1);

    const split = readPublications([
      ...events(message, { emitter: "a" }).slice(0, 2),
      ...events(message, { emitter: "b" }).slice(2),
    ]);
    expect(split.results.map((result) => result.status)).toEqual([
      ReadStatus.Incomplete,
      ReadStatus.Incomplete,
    ]);
    const networks = readPublications([
      ...events(message, { network: "n1" }).slice(0, 1),
      ...events(message, { network: "n2" }).slice(1),
    ]);
    expect(networks.results.map((result) => result.status)).toEqual([
      ReadStatus.Incomplete,
      ReadStatus.Incomplete,
    ]);
  });

  it("ignores foreign names and filtered emitters/networks without affecting the publication", () => {
    const base = events(patternMessage(300));
    const foreign: PublicEvent = {
      ...at(base, 0),
      eventId: "app-1",
      name: Uint8Array.from([...ascii("app:transfer"), ...new Uint8Array(20)]),
    };
    const otherVersion: PublicEvent = {
      ...at(base, 0),
      eventId: "v2-1",
      name: Uint8Array.from([...ascii("mip-xxxx[v2]:001:002"), ...new Uint8Array(12)]),
    };
    const otherEmitter = events(patternMessage(10), { emitter: "someone-else", idPrefix: "x" });
    const output = readPublications([foreign, ...base, otherVersion, ...otherEmitter], {
      emitter: "emitter",
      network: "net",
    });
    expect(output.ignoredEvents).toBe(3);
    expect(output.results).toHaveLength(1);
    expect(output.results[0]?.status).toBe(ReadStatus.Complete);
  });

  it("a malformed profile event with a recoverable request ID rejects its group in any order", () => {
    const base = events(patternMessage(417));
    for (const width of [255, 257, 32]) {
      const bad: PublicEvent = {
        ...at(base, 1),
        eventId: "bad",
        payload: Uint8Array.from({ length: width }, (_, i) => at(base, 1).payload[i] ?? 0),
      };
      for (const input of [
        [bad, ...base],
        [...base, bad],
      ]) {
        const { results } = readPublications(input);
        expect(results).toHaveLength(1);
        expect(results[0]?.status).toBe(ReadStatus.Rejected);
        expect(results[0]?.issues.join()).toMatch(/event payload must be 256 bytes/);
      }
    }
  });

  it("a source-reported defect (e.g. fallible placement) rejects the group", () => {
    const base = events(patternMessage(417));
    const flagged = { ...at(base, 2), sourceIssue: "emitted from a fallible transcript" };
    const { results } = readPublications([at(base, 0), at(base, 1), flagged]);
    expect(results[0]?.status).toBe(ReadStatus.Rejected);
    expect(results[0]?.issues).toContain(
      "malformed event in group: emitted from a fallible transcript",
    );
  });

  it("payloads shorter than a request ID and empty scopes cannot be grouped", () => {
    const base = events(patternMessage(10));
    const short = { ...at(base, 0), eventId: "short", payload: new Uint8Array(31) };
    const noTx = { ...at(base, 0), eventId: "no-tx", transactionId: "" };
    const noId = { ...at(base, 0), eventId: "" };
    const { results } = readPublications([short, noTx, noId, ...base]);
    expect(
      results.map((result) => [result.status, result.scope.requestIdHex === undefined]),
    ).toEqual([
      [ReadStatus.Complete, false],
      [ReadStatus.Rejected, true],
      [ReadStatus.Rejected, true],
      [ReadStatus.Rejected, true],
    ]);
  });

  it("never accepts a prefix across page or reconnect boundaries", () => {
    const base = events(patternMessage(1024));
    for (let pageSize = 1; pageSize <= base.length; pageSize += 1) {
      const seen: PublicEvent[] = [];
      for (let start = 0; start < base.length; start += pageSize) {
        // Each reconnect replays the previous page too (duplicates across boundaries).
        seen.push(...base.slice(Math.max(0, start - pageSize), start + pageSize));
        const { results } = readPublications(seen);
        const complete = start + pageSize >= base.length;
        expect(results[0]?.status).toBe(complete ? ReadStatus.Complete : ReadStatus.Incomplete);
      }
    }
  });
});

describe("reader determinism (no dependence on input order or locale)", () => {
  it("every order of two groups plus two ungroupable rejections gives the same output", () => {
    const a = events(patternMessage(250), { transactionId: "tx-a" });
    const b = events(patternMessage(100), { transactionId: "tx-B" });
    const shortPayload = { ...at(b, 0), eventId: "short", payload: new Uint8Array(8) };
    const emptyTx = { ...at(a, 0), eventId: "no-tx", transactionId: "" };
    const conflicting = {
      ...at(a, 1),
      eventId: "e9",
      payload: at(a, 1).payload.map((x, i) => (i === 90 ? x ^ 1 : x)),
    };
    const input = [at(a, 0), at(a, 1), at(b, 0), shortPayload, emptyTx, conflicting];
    const reference = render(readPublications(input));
    let count = 0;
    for (const order of permutations(input)) {
      expect(render(readPublications(order))).toBe(reference);
      count += 1;
    }
    expect(count).toBe(720);
    const parsed = readPublications(input).results;
    expect(parsed.map((result) => result.status)).toEqual([
      ReadStatus.Complete,
      ReadStatus.Rejected,
      ReadStatus.Rejected,
      ReadStatus.Rejected,
    ]);
  });

  it("orders results by code units, not by the host locale", () => {
    const ids = ["tx_a", "tx-1", "tx-a", "tx-B"];
    const input = ids.flatMap((transactionId) => events(patternMessage(5), { transactionId }));
    const order = readPublications(input).results.map((result) => result.scope.transactionId);
    expect(order).toEqual(["tx-1", "tx-B", "tx-a", "tx_a"]);
  });
});

describe("reader bounds and canonical metadata", () => {
  it("rejects input beyond maxEvents or maxGroups and invalid limits", () => {
    const base = events(patternMessage(417));
    const limits = { maxMessageBytes: 1000, maxParts: 8, maxEvents: 2, maxGroups: 1 };
    expect(() => readPublications(base, { limits })).toThrow(/maxEvents/);
    const twoGroups = [
      ...events(patternMessage(1), { transactionId: "t1" }),
      ...events(patternMessage(1), { transactionId: "t2" }),
    ];
    expect(() => readPublications(twoGroups, { limits })).toThrow(/maxGroups/);
    expect(() => readPublications([], { limits: { ...limits, maxEvents: 0 } })).toThrow(
      /maxEvents/,
    );
    expect(() => readPublications([], { limits: { ...limits, maxParts: 1000 } })).toThrow(
      /maxParts/,
    );
  });

  it("rejects groups whose declared size exceeds the reader's per-message limits", () => {
    const base = events(patternMessage(1024));
    const small = readPublications(base, {
      limits: { maxMessageBytes: 1000, maxParts: 8, maxEvents: 16, maxGroups: 4 },
    });
    expect(small.results[0]?.status).toBe(ReadStatus.Rejected);
    expect(small.results[0]?.issues.join()).toMatch(/exceeds maxMessageBytes/);
    const fewParts = readPublications(base, {
      limits: { maxMessageBytes: 4000, maxParts: 4, maxEvents: 16, maxGroups: 4 },
    });
    expect(fewParts.results[0]?.issues.join()).toMatch(/exceeds maxParts/);
  });

  it("decodeFragment reports the violated rule", () => {
    const [event] = events(patternMessage(10));
    if (event === undefined) throw new Error("no event");
    expect(decodeFragment(event.name, event.payload)).toMatchObject({
      position: 1,
      total: 1,
      messageLength: 10,
    });
    expect(() => decodeFragment(new Uint8Array(32), event.payload)).toThrow(/profile prefix/);
    const tail = event.payload.slice(32);
    new DataView(tail.buffer).setBigUint64(8, 300n, true); // n should be 2 now
    expect(() =>
      decodeFragment(eventNameFor(tail), eventPayloadFor(event.payload.slice(0, 32), tail)),
    ).toThrow(/not canonical/);
  });
});
