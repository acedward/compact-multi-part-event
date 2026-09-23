/**
 * Width restoration: the ledger trims trailing zero bytes of the 288-byte event value;
 * adapters must restore the 32-byte name and 256-byte payload before strict reading.
 */
import { describe, expect, it } from "vitest";

import {
  encodePublication,
  eventValueFor,
  type PublicEvent,
  readPublications,
  ReadStatus,
  restoreEventValue,
  restoreIndexerMiscEvent,
} from "../src/codec/index.js";
import { patternMessage, toHex } from "./helpers/bytes.js";

const trim = (bytes: Uint8Array): Uint8Array => {
  let end = bytes.byteLength;
  while (end > 0 && bytes[end - 1] === 0) end -= 1;
  return bytes.slice(0, end);
};

const trimmedValues = (message: Uint8Array): Uint8Array[] => {
  const publication = encodePublication(message);
  return publication.parts.map((part) => trim(eventValueFor(publication.requestId, part.tail)));
};

const asEvents = (values: readonly { name: Uint8Array; payload: Uint8Array }[]): PublicEvent[] =>
  values.map((value, index) => ({
    network: "net",
    emitter: "emitter",
    transactionId: "tx",
    eventId: `e${String(index)}`,
    ...value,
  }));

describe("ledger value restoration", () => {
  it.each([
    [0, [71]],
    [1, [81]],
    [208, [288]],
    [417, [288, 288, 81]],
  ])("L=%i: trimmed atoms %j are restored and read as complete", (length, atomLengths) => {
    const values = trimmedValues(patternMessage(length));
    expect(values.map((value) => value.byteLength)).toEqual(atomLengths);
    const { results } = readPublications(asEvents(values.map(restoreEventValue)));
    expect(results[0]?.status).toBe(ReadStatus.Complete);
    expect(results[0]?.message).toEqual(patternMessage(length));
  });

  it("keeps meaningful trailing zeros of the message", () => {
    const message = Uint8Array.from([...patternMessage(250), 0, 0, 0, 0, 0]);
    const values = trimmedValues(message);
    const { results } = readPublications(asEvents(values.map(restoreEventValue)));
    expect(results[0]?.message).toEqual(message);
  });

  it("without restoration the strict reader rejects a trimmed final part", () => {
    const values = trimmedValues(patternMessage(417));
    const naive = values.map((value) => ({ name: value.slice(0, 32), payload: value.slice(32) }));
    const { results } = readPublications(asEvents(naive));
    expect(results[0]?.status).toBe(ReadStatus.Rejected);
    expect(results[0]?.issues.join()).toMatch(/event payload must be 256 bytes/);
  });

  it("refuses values longer than 288 bytes", () => {
    expect(() => restoreEventValue(new Uint8Array(289))).toThrow(/at most 288/);
  });
});

describe("indexer field restoration", () => {
  const publication = encodePublication(patternMessage(417));
  const lastPart = publication.parts[2];
  if (lastPart === undefined) throw new Error("no part");
  const full = eventValueFor(publication.requestId, lastPart.tail);
  const nameHex = toHex(full.slice(0, 32));
  const payloadHex = toHex(full.slice(32));

  it("accepts full-width fields (the indexer pads) and trimmed payloads", () => {
    expect(restoreIndexerMiscEvent({ name: nameHex, payload: payloadHex })).toEqual({
      name: full.slice(0, 32),
      payload: full.slice(32),
    });
    const trimmedPayload = toHex(trim(full).slice(32));
    expect(restoreIndexerMiscEvent({ name: nameHex, payload: trimmedPayload }).payload).toEqual(
      full.slice(32),
    );
    expect(
      restoreIndexerMiscEvent({ name: nameHex.toUpperCase(), payload: payloadHex }).name,
    ).toEqual(full.slice(0, 32));
  });

  it.each([
    ["odd length", { name: nameHex.slice(1), payload: payloadHex }, /odd length/],
    ["non-hex", { name: `zz${nameHex.slice(2)}`, payload: payloadHex }, /non-hex/],
    ["0x prefix", { name: `0x${nameHex}`, payload: payloadHex }, /non-hex/],
    ["empty name", { name: "", payload: "" }, /empty name/],
    ["long name", { name: `${nameHex}00`, payload: payloadHex }, /name is longer/],
    ["long payload", { name: nameHex, payload: `${payloadHex}00` }, /payload is longer/],
    [
      "short name with payload",
      { name: nameHex.slice(0, 40), payload: payloadHex },
      /shorter than 32/,
    ],
  ])("rejects %s", (_, fields, pattern) => {
    expect(() => restoreIndexerMiscEvent(fields)).toThrow(pattern);
  });
});
