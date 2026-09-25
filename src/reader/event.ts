/**
 * `Misc` event values: widths, event names and width restoration.
 *
 * A `Misc` event is a 32-byte name and a 256-byte payload, logged as one 288-byte
 * value (name then payload). The ledger stores that value with its trailing zero bytes
 * removed, so a payload that ends in zeros (or an all-zero payload after a name that
 * ends in zeros) arrives shorter. Every reader restores both widths before comparing
 * names or merging payloads.
 *
 * @module
 */
import { bytesToHex, hexToBytes } from "./bytes.js";

/** Width of a `Misc` event name. */
export const NAME_LENGTH = 32;

/** Width of a `Misc` event payload, and so of one part of a package. */
export const PAYLOAD_LENGTH = 256;

/** Width of the whole `Misc` event value: name followed by payload. */
export const EVENT_LENGTH = NAME_LENGTH + PAYLOAD_LENGTH;

/**
 * The 32-byte event name for a text, as Compact's `pad(32, text)` builds it: the UTF-8
 * bytes, then zero bytes. Pass 32 bytes to use them as they are.
 *
 * @throws {RangeError} If the text is empty or longer than 32 bytes, or the bytes are
 * not exactly 32.
 */
export const eventName = (name: string | Uint8Array): Uint8Array => {
  if (typeof name !== "string") {
    if (name.byteLength !== NAME_LENGTH) throw new RangeError("an event name is 32 bytes");
    return Uint8Array.from(name);
  }
  const encoded = new TextEncoder().encode(name);
  if (encoded.byteLength === 0) throw new RangeError("an event name must not be empty");
  if (encoded.byteLength > NAME_LENGTH) {
    throw new RangeError(`event name '${name}' is longer than 32 bytes`);
  }
  const out = new Uint8Array(NAME_LENGTH);
  out.set(encoded);
  return out;
};

/**
 * Readable form of a 32-byte name: the text before the zero padding when it is
 * printable ASCII, otherwise `0x` and the hex of all 32 bytes.
 */
export const eventNameText = (name: Uint8Array): string => {
  let end = name.byteLength;
  while (end > 0 && name[end - 1] === 0) end -= 1;
  const text = name.subarray(0, end);
  const printable = text.every((byte) => byte >= 0x20 && byte < 0x7f);
  return printable && end > 0 ? new TextDecoder().decode(text) : `0x${bytesToHex(name)}`;
};

/** A width-restored event value. */
export interface RestoredEvent {
  /** 32 bytes. */
  readonly name: Uint8Array;
  /** 256 bytes. */
  readonly payload: Uint8Array;
}

/**
 * Restore a stored event value (name then payload, trailing zeros possibly removed) to
 * its full 288 bytes.
 *
 * @throws {RangeError} If the value is longer than 288 bytes.
 */
export const restoreEventValue = (value: Uint8Array): Uint8Array => {
  if (value.byteLength > EVENT_LENGTH) {
    throw new RangeError(`event value is ${String(value.byteLength)} bytes; at most 288 allowed`);
  }
  const full = new Uint8Array(EVENT_LENGTH);
  full.set(value);
  return full;
};

/**
 * Restore a stored event value and split it into name and payload.
 *
 * @throws {RangeError} If the value is longer than 288 bytes.
 */
export const splitEventValue = (value: Uint8Array): RestoredEvent => {
  const full = restoreEventValue(value);
  return { name: full.slice(0, NAME_LENGTH), payload: full.slice(NAME_LENGTH) };
};

/** The 288-byte value of a name and a payload (each at most its width; zero-padded). */
export const eventValue = (name: Uint8Array, payload: Uint8Array): Uint8Array => {
  if (name.byteLength > NAME_LENGTH) throw new RangeError("event name is longer than 32 bytes");
  if (payload.byteLength > PAYLOAD_LENGTH) {
    throw new RangeError("event payload is longer than 256 bytes");
  }
  const value = new Uint8Array(EVENT_LENGTH);
  value.set(name, 0);
  value.set(payload, NAME_LENGTH);
  return value;
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
  return splitEventValue(eventValue(name, payload));
};
