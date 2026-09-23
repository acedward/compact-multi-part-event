/**
 * Width restoration for event sources.
 *
 * The ledger stores a `Misc` event value (name then payload, declared `Bytes<288>`)
 * as one atom with its trailing zero bytes removed, so a final part with padding,
 * or an empty message, arrives shorter than 288 bytes. Every event source adapter
 * MUST restore the widths before handing events to the strict reader, which never
 * accepts short payloads itself.
 *
 * @module
 */
import { hexToBytes } from "./bytes.js";
import { EVENT_LENGTH, NAME_LENGTH, PAYLOAD_LENGTH } from "./constants.js";

/** A width-restored event value. */
export interface RestoredEvent {
  /** 32 bytes. */
  readonly name: Uint8Array;
  /** 256 bytes. */
  readonly payload: Uint8Array;
}

/**
 * Restore a trimmed 288-byte event value (name then payload).
 *
 * @param value - The stored atom: at most 288 bytes, trailing zeros possibly removed.
 * @throws {RangeError} If the value is longer than 288 bytes.
 */
export const restoreEventValue = (value: Uint8Array): RestoredEvent => {
  if (value.byteLength > EVENT_LENGTH) {
    throw new RangeError(`event value is ${String(value.byteLength)} bytes; at most 288 allowed`);
  }
  const full = new Uint8Array(EVENT_LENGTH);
  full.set(value);
  return { name: full.slice(0, NAME_LENGTH), payload: full.slice(NAME_LENGTH) };
};

/** `name`/`payload` hex fields of an indexer `MiscContractEvent`. */
export interface IndexerMiscFields {
  readonly name: string;
  readonly payload: string;
}

/**
 * Restore the widths of an indexer `MiscContractEvent`'s hex fields.
 *
 * Indexer v4.4.0-rc.1 pads the stored value back to 288 bytes before splitting it,
 * and returns empty fields when it could not parse the value; other sources may
 * split the trimmed value directly. Trimming only removes bytes from the end of
 * the 288-byte value, so a name shorter than 32 bytes implies an empty payload.
 *
 * @throws {RangeError} On non-hex input, empty fields, over-long fields, or a short
 * name followed by payload bytes.
 */
export const restoreIndexerMiscEvent = (fields: IndexerMiscFields): RestoredEvent => {
  const name = hexToBytes(fields.name);
  const payload = hexToBytes(fields.payload);
  if (name.byteLength === 0) {
    throw new RangeError("event has an empty name (the indexer could not parse its value)");
  }
  if (name.byteLength > NAME_LENGTH) throw new RangeError("event name is longer than 32 bytes");
  if (payload.byteLength > PAYLOAD_LENGTH) {
    throw new RangeError("event payload is longer than 256 bytes");
  }
  if (name.byteLength < NAME_LENGTH && payload.byteLength > 0) {
    throw new RangeError("event name is shorter than 32 bytes but a payload follows");
  }
  const restoredName = new Uint8Array(NAME_LENGTH);
  restoredName.set(name);
  const restoredPayload = new Uint8Array(PAYLOAD_LENGTH);
  restoredPayload.set(payload);
  return { name: restoredName, payload: restoredPayload };
};
