/**
 * The reader (FR-005) on synthetic events: exact-name filter, grouping per (network,
 * contract, N, transaction, segment), order by position never by delivery order,
 * redelivery and identity conflicts, merged payloads, width restoration, other names
 * and contracts untouched, bounds, and output independent of input order.
 */
import { describe, expect, it } from "vitest";

import {
  eventName,
  eventNameText,
  eventValue,
  type PartEvent,
  readPackages,
  restoreEventValue,
  restoreIndexerMiscEvent,
  splitEventValue,
} from "../src/reader/index.js";
import { ascii, patternParts, shortPart, toHex } from "./helpers/bytes.js";

const NAME = "example:message[v1]";
const OTHER_NAME = "example:other[v1]";
const A = "aa".repeat(32);
const B = "bb".repeat(32);
const TX1 = "01".repeat(32);
const TX2 = "02".repeat(32);

const trimmed = (value: Uint8Array): Uint8Array => {
  let end = value.byteLength;
  while (end > 0 && value[end - 1] === 0) end -= 1;
  return value.slice(0, end);
};

const event = (
  part: Uint8Array,
  overrides: Partial<Omit<PartEvent, "value">> & { readonly name?: string } = {},
): PartEvent => ({
  network: overrides.network ?? "local",
  contract: overrides.contract ?? A,
  transactionHash: overrides.transactionHash ?? TX1,
  segment: overrides.segment ?? 7,
  position: overrides.position ?? 0,
  value: trimmed(eventValue(eventName(overrides.name ?? NAME), part)),
});

const optIns = [{ contract: A, name: NAME }];

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.length * 256);
  parts.forEach((part, index) => out.set(part, index * 256));
  return out;
};

describe("event names and widths", () => {
  it("pads a name like Compact's pad(32, text) and refuses empty or over-long names", () => {
    const name = eventName(NAME);
    expect(name.byteLength).toBe(32);
    expect(name.subarray(0, 19)).toEqual(ascii(NAME));
    expect(name.subarray(19)).toEqual(new Uint8Array(13));
    expect(eventName(name)).toEqual(name);
    expect(eventNameText(name)).toBe(NAME);
    expect(eventNameText(new Uint8Array(32).fill(0xff))).toBe(`0x${"ff".repeat(32)}`);
    expect(() => eventName("")).toThrow(/empty/);
    expect(() => eventName("x".repeat(33))).toThrow(/longer than 32 bytes/);
    expect(() => eventName(new Uint8Array(31))).toThrow(/32 bytes/);
  });

  it("restores trimmed values to 288 bytes and refuses longer ones", () => {
    const part = shortPart(ascii("hello"));
    const full = eventValue(eventName(NAME), part);
    const stored = trimmed(full);
    expect(stored.byteLength).toBe(37);
    expect(restoreEventValue(stored)).toEqual(full);
    expect(splitEventValue(stored)).toEqual({ name: eventName(NAME), payload: part });
    // An all-zero payload after a name that ends in zeros: the name itself is trimmed.
    const allZero = trimmed(eventValue(eventName(NAME), new Uint8Array(256)));
    expect(allZero.byteLength).toBe(19);
    expect(splitEventValue(allZero).name).toEqual(eventName(NAME));
    expect(() => restoreEventValue(new Uint8Array(289))).toThrow(/at most 288/);
  });

  it("restores indexer hex fields and refuses inconsistent ones", () => {
    const part = shortPart(ascii("hi"));
    const nameHex = toHex(eventName(NAME));
    expect(restoreIndexerMiscEvent({ name: nameHex, payload: toHex(part) })).toEqual({
      name: eventName(NAME),
      payload: part,
    });
    expect(restoreIndexerMiscEvent({ name: nameHex, payload: toHex(ascii("hi")) }).payload).toEqual(
      part,
    );
    expect(() => restoreIndexerMiscEvent({ name: "", payload: "" })).toThrow(/empty name/);
    expect(() => restoreIndexerMiscEvent({ name: nameHex.slice(0, 20), payload: "00" })).toThrow(
      /shorter than 32 bytes but a payload follows/,
    );
    expect(() => restoreIndexerMiscEvent({ name: nameHex, payload: "00".repeat(257) })).toThrow(
      /longer than 256/,
    );
  });
});

describe("grouping and merging", () => {
  it("one intent's events are one package: parts in position order, payload their concatenation", () => {
    for (const count of [1, 2, 8]) {
      const parts = patternParts(count, count);
      const events = parts.map((part, index) => event(part, { position: 100 + index }));
      const { packages, ignored } = readPackages(events, { optIns });
      expect(ignored).toBe(0);
      expect(packages).toHaveLength(1);
      const [pkg] = packages;
      expect(pkg?.status).toBe("accepted");
      expect(pkg?.nameText).toBe(NAME);
      expect(pkg?.segment).toBe(7);
      expect(pkg?.positions).toEqual(parts.map((_, index) => 100 + index));
      expect(pkg?.parts).toEqual(parts);
      expect(pkg?.payload).toEqual(concat(parts));
    }
  });

  it("orders by position, never by delivery order (reversed and shuffled deliveries)", () => {
    const parts = patternParts(5, 3);
    const events = parts.map((part, index) => event(part, { position: index * 10 }));
    const expected = readPackages(events, { optIns }).packages;
    for (const order of [
      [4, 3, 2, 1, 0],
      [2, 0, 4, 1, 3],
    ]) {
      const shuffled = order.map((index) => events[index] as PartEvent);
      expect(readPackages(shuffled, { optIns }).packages).toEqual(expected);
    }
  });

  it("each intent (segment) is its own package; so is each transaction, contract and network", () => {
    const [p1, p2, p3] = patternParts(3, 5) as [Uint8Array, Uint8Array, Uint8Array];
    const events = [
      event(p1, { segment: 7, position: 0 }),
      event(p2, { segment: 7, position: 1 }),
      event(p3, { segment: 9, position: 2 }),
      event(p1, { transactionHash: TX2, position: 0 }),
      event(p1, { contract: B, position: 0 }),
      event(p1, { network: "other", position: 0 }),
    ];
    const { packages } = readPackages(events, {
      optIns: [...optIns, { contract: B, name: NAME }],
    });
    expect(
      packages.map((pkg) => [
        pkg.network,
        pkg.contract.slice(0, 2),
        pkg.transactionHash.slice(0, 2),
        pkg.segment,
        pkg.parts.length,
      ]),
    ).toEqual([
      ["local", "aa", "01", 7, 2],
      ["local", "aa", "01", 9, 1],
      ["local", "aa", "02", 7, 1],
      ["local", "bb", "01", 7, 1],
      ["other", "aa", "01", 7, 1],
    ]);
    expect(packages.every((pkg) => pkg.status === "accepted")).toBe(true);
    // The network filter keeps only one network.
    expect(readPackages(events, { optIns, network: "other" })).toMatchObject({ ignored: 5 });
  });

  it("the same payload repeated in another transaction is another package", () => {
    const parts = patternParts(2, 8);
    const events = [
      ...parts.map((part, index) => event(part, { position: index })),
      ...parts.map((part, index) => event(part, { transactionHash: TX2, position: index })),
    ];
    const { packages } = readPackages(events, { optIns });
    expect(packages).toHaveLength(2);
    expect(packages[0]?.payload).toEqual(packages[1]?.payload);
  });

  it("restores widths: a trimmed last part merges as its full 256 bytes", () => {
    const parts = [...patternParts(1, 2), shortPart(ascii("tail"))];
    const events = parts.map((part, index) => event(part, { position: index }));
    expect(events[1]?.value.byteLength).toBe(36);
    const [pkg] = readPackages(events, { optIns }).packages;
    expect(pkg?.payload).toEqual(concat(parts));
    expect(pkg?.payload?.byteLength).toBe(512);
  });
});

describe("identities", () => {
  it("tolerates identical redelivery of one identity (also trimmed versus full width)", () => {
    const parts = patternParts(2, 4);
    const events = parts.map((part, index) => event(part, { position: index }));
    const [first] = events;
    if (first === undefined) throw new Error("no event");
    const full = { ...first, value: restoreEventValue(first.value) };
    const { packages } = readPackages([...events, first, full], { optIns });
    expect(packages[0]?.status).toBe("accepted");
    expect(packages[0]?.deliveries).toBe(4);
    expect(packages[0]?.parts).toEqual(parts);
  });

  it("rejects the package when one identity arrives with two contents", () => {
    const [p1, p2] = patternParts(2, 6) as [Uint8Array, Uint8Array];
    const events = [
      event(p1, { position: 0 }),
      event(p2, { position: 1 }),
      event(p2, { position: 0 }),
    ];
    const [pkg] = readPackages(events, { optIns }).packages;
    expect(pkg?.status).toBe("rejected");
    expect(pkg?.payload).toBeUndefined();
    expect(pkg?.issues).toEqual(["position 0 was delivered with two contents"]);
  });

  it("the same bytes at two positions are two parts (the reader counts identities, not contents)", () => {
    const [part] = patternParts(1, 7) as [Uint8Array];
    const [pkg] = readPackages([event(part, { position: 0 }), event(part, { position: 1 })], {
      optIns,
    }).packages;
    expect(pkg?.parts).toEqual([part, part]);
  });

  it("an over-long value under the name rejects its package", () => {
    const [part] = patternParts(1, 7) as [Uint8Array];
    const long = new Uint8Array(289);
    long.set(eventValue(eventName(NAME), part));
    const events = [event(part, { position: 0 }), { ...event(part, { position: 1 }), value: long }];
    const [pkg] = readPackages(events, { optIns }).packages;
    expect(pkg?.status).toBe("rejected");
    expect(pkg?.issues.join()).toMatch(/position 1: event value is 289 bytes/);
  });
});

describe("other names and contracts are untouched", () => {
  it("ignores events with other names, from other contracts, and from a contract that did not opt in", () => {
    const [part] = patternParts(1, 1) as [Uint8Array];
    const events = [
      event(part, { position: 0 }),
      event(part, { position: 1, name: OTHER_NAME }),
      event(part, { position: 2, name: "example:message[v2]" }),
      event(part, { position: 3, contract: B }),
      { ...event(part, { position: 4 }), value: ascii("junk") },
    ];
    const { packages, ignored } = readPackages(events, { optIns });
    expect(ignored).toBe(4);
    expect(packages).toHaveLength(1);
    expect(packages[0]?.parts).toEqual([part]);
  });

  it("a name that is a prefix of N, or N with other padding, is another name", () => {
    const [part] = patternParts(1, 2) as [Uint8Array];
    const padded = eventName(NAME);
    padded[31] = 1;
    const events = [
      event(part, { position: 0, name: "example:message" }),
      { ...event(part, { position: 1 }), value: eventValue(padded, part) },
    ];
    expect(readPackages(events, { optIns })).toEqual({ packages: [], ignored: 2 });
  });

  it("two opted-in names of one contract are separate packages even in one intent", () => {
    const [p1, p2] = patternParts(2, 3) as [Uint8Array, Uint8Array];
    const events = [event(p1, { position: 0 }), event(p2, { position: 1, name: OTHER_NAME })];
    const { packages } = readPackages(events, {
      optIns: [...optIns, { contract: A, name: OTHER_NAME }],
    });
    expect(packages.map((pkg) => [pkg.nameText, pkg.parts.length])).toEqual([
      [NAME, 1],
      [OTHER_NAME, 1],
    ]);
  });
});

describe("bounds and input validation", () => {
  it("refuses more events or packages than the limits, and invalid limits", () => {
    const parts = patternParts(3, 1);
    const events = parts.map((part, index) => event(part, { segment: index + 1 }));
    expect(() =>
      readPackages(events, { optIns, limits: { maxEvents: 2, maxPackages: 10 } }),
    ).toThrow(/maxEvents 2/);
    expect(() =>
      readPackages(events, { optIns, limits: { maxEvents: 10, maxPackages: 2 } }),
    ).toThrow(/maxPackages 2/);
    expect(() =>
      readPackages(events, { optIns, limits: { maxEvents: 0, maxPackages: 1 } }),
    ).toThrow(/maxEvents must be a positive safe integer/);
    expect(
      readPackages(events, { optIns, limits: { maxEvents: 3, maxPackages: 3 } }).packages,
    ).toHaveLength(3);
  });

  it("refuses invalid configuration and invalid source fields", () => {
    const [part] = patternParts(1) as [Uint8Array];
    expect(() => readPackages([], { optIns: [] })).toThrow(/at least one/);
    expect(() => readPackages([], { optIns: [{ contract: A.toUpperCase(), name: NAME }] })).toThrow(
      /64 lowercase hex/,
    );
    expect(() => readPackages([event(part, { segment: 0 })], { optIns })).toThrow(/segment 0/);
    expect(() => readPackages([event(part, { segment: 65536 })], { optIns })).toThrow(/segment/);
    expect(() => readPackages([event(part, { position: -1 })], { optIns })).toThrow(/position/);
    expect(() => readPackages([event(part, { transactionHash: "" })], { optIns })).toThrow(
      /empty network or transaction hash/,
    );
  });
});
