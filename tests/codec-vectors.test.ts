/**
 * Golden vectors (vectors/v1.json) derived independently by vectors/derive.py from
 * the normative wire table. The writer must reproduce them byte for byte, and the
 * reader must classify the literal committed events without calling the writer.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  encodePublication,
  eventNameFor,
  type PublicEvent,
  readPublications,
  ReadStatus,
} from "../src/codec/index.js";
import { fromHex, toHex } from "./helpers/bytes.js";

interface VectorEvent {
  readonly eventId: string;
  readonly name: string;
  readonly payload: string;
}
interface Vectors {
  readonly profile: string;
  readonly valid: readonly {
    readonly id: string;
    readonly messageLength: number;
    readonly messageHex: string;
    readonly requestId: string;
    readonly parts: readonly {
      readonly position: number;
      readonly total: number;
      readonly tail: string;
      readonly name: string;
    }[];
  }[];
  readonly invalidEvents: readonly {
    readonly id: string;
    readonly event: VectorEvent;
    readonly expect: "rejected" | "ungroupable" | "ignored";
    readonly reason: string;
  }[];
  readonly groups: readonly {
    readonly id: string;
    readonly events: readonly VectorEvent[];
    readonly expect: "complete" | "incomplete" | "rejected";
    readonly reason: string;
  }[];
}

const vectors = JSON.parse(
  readFileSync(new URL("../vectors/v1.json", import.meta.url), "utf8"),
) as Vectors;

const LIMITS = { maxMessageBytes: 64 * 208, maxParts: 64, maxEvents: 256, maxGroups: 16 };

const asEvent = (event: VectorEvent, transactionId = "tx-1"): PublicEvent => ({
  network: "vectors",
  emitter: "emitter",
  transactionId,
  eventId: event.eventId,
  name: fromHex(event.name),
  payload: fromHex(event.payload),
});

describe("golden vectors", () => {
  it("cover the required lengths, the 46-part fit and zero-heavy messages", () => {
    expect(vectors.profile).toBe("mip-xxxx[v1]");
    expect(vectors.valid.map((vector) => vector.messageLength)).toEqual([
      0, 1, 207, 208, 209, 416, 417, 640, 1024, 9568, 300, 416,
    ]);
    expect(vectors.valid.find((vector) => vector.id === "parts-46")?.parts).toHaveLength(46);
  });

  it.each(vectors.valid.map((vector) => [vector.id, vector] as const))(
    "%s: the writer reproduces every tail, name and the request ID",
    (_, vector) => {
      const encoded = encodePublication(fromHex(vector.messageHex), LIMITS);
      expect(toHex(encoded.requestId)).toBe(vector.requestId);
      expect(encoded.messageLength).toBe(vector.messageLength);
      expect(encoded.parts.map((part) => [part.position, part.total, toHex(part.tail)])).toEqual(
        vector.parts.map((part) => [part.position, part.total, part.tail]),
      );
      expect(encoded.parts.map((part) => toHex(eventNameFor(part.tail)))).toEqual(
        vector.parts.map((part) => part.name),
      );
    },
  );

  it.each(vectors.valid.map((vector) => [vector.id, vector] as const))(
    "%s: the reader rebuilds the message from the literal events",
    (_, vector) => {
      const events = vector.parts.map((part, index) =>
        asEvent({
          eventId: `e${String(index + 1)}`,
          name: part.name,
          payload: vector.requestId + part.tail,
        }),
      );
      const { results, ignoredEvents } = readPublications([...events].reverse(), {
        limits: LIMITS,
      });
      expect(ignoredEvents).toBe(0);
      expect(results).toHaveLength(1);
      expect(results[0]?.status).toBe(ReadStatus.Complete);
      expect(results[0]?.expectedParts).toBe(vector.parts.length);
      expect(toHex(results[0]?.message ?? new Uint8Array())).toBe(vector.messageHex);
      expect(results[0]?.scope.requestIdHex).toBe(vector.requestId);
    },
  );

  it.each(vectors.invalidEvents.map((entry) => [entry.id, entry] as const))(
    "invalid event %s is classified as expected",
    (_, entry) => {
      const { results, ignoredEvents } = readPublications([asEvent(entry.event)], {
        limits: LIMITS,
      });
      if (entry.expect === "ignored") {
        expect(ignoredEvents).toBe(1);
        expect(results).toHaveLength(0);
        return;
      }
      expect(ignoredEvents).toBe(0);
      expect(results).toHaveLength(1);
      const [result] = results;
      expect(result?.status).toBe(ReadStatus.Rejected);
      expect(result?.scope.requestIdHex === undefined).toBe(entry.expect === "ungroupable");
      expect(result?.issues.join(" | ")).toContain(entry.reason);
    },
  );

  it.each(vectors.groups.map((entry) => [entry.id, entry] as const))(
    "group %s is classified as expected",
    (_, entry) => {
      const { results } = readPublications(
        entry.events.map((event) => asEvent(event)),
        { limits: LIMITS },
      );
      expect(results).toHaveLength(1);
      expect(results[0]?.status).toBe(entry.expect);
      expect(results[0]?.issues.join(" | ")).toContain(entry.reason);
    },
  );
});
