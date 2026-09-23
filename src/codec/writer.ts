/**
 * Caller-side writer: split a message into canonical 224-byte tails and derive
 * the request ID. The emission circuit forwards these bytes unchanged.
 *
 * @module
 */
import { createHash } from "node:crypto";

import {
  type CodecLimits,
  DATA_OFFSET,
  DEFAULT_CODEC_LIMITS,
  LENGTH_FIELD_OFFSET,
  NAME_LENGTH,
  NAME_POSITION_OFFSET,
  namePrefix,
  PART_DATA_LENGTH,
  PAYLOAD_LENGTH,
  POSITION_FIELD_LENGTH,
  REQUEST_ID_LENGTH,
  TAIL_LENGTH,
  validateCodecLimits,
} from "./constants.js";
import { encodePosition } from "./position.js";

/** One canonical part: the `emitPart` payload argument and the event it produces. */
export interface EncodedPart {
  /** 1-based part number. */
  readonly position: number;
  /** Total number of parts. */
  readonly total: number;
  /** The 224-byte tail passed to `emitPart`. */
  readonly tail: Uint8Array;
}

/** A complete canonical publication. */
export interface EncodedPublication {
  /** SHA-256 over every tail in part order, metadata and padding included. */
  readonly requestId: Uint8Array;
  /** Original message length in bytes. */
  readonly messageLength: number;
  /** Parts in order 1..n. */
  readonly parts: readonly EncodedPart[];
}

/** `n = max(1, ceil(length / 208))`. */
export const partCountFor = (messageLength: number): number =>
  Math.max(1, Math.ceil(messageLength / PART_DATA_LENGTH));

/**
 * Split a message into canonical tails and hash them. Identical messages give
 * identical request IDs; transaction scope keeps their publications apart.
 *
 * @param message - Message bytes; embedded and trailing zeros are meaningful.
 * @param limits - Allocation limits for this call.
 * @throws {RangeError} If the message exceeds the limits.
 */
export const encodePublication = (
  message: Uint8Array,
  limits: CodecLimits = DEFAULT_CODEC_LIMITS,
): EncodedPublication => {
  validateCodecLimits(limits);
  if (message.byteLength > limits.maxMessageBytes) {
    throw new RangeError(
      `message length ${String(message.byteLength)} exceeds maxMessageBytes ${String(limits.maxMessageBytes)}`,
    );
  }
  const total = partCountFor(message.byteLength);
  if (total > limits.maxParts) {
    throw new RangeError(
      `message needs ${String(total)} parts; maxParts is ${String(limits.maxParts)}`,
    );
  }
  const hash = createHash("sha256");
  const parts: EncodedPart[] = [];
  for (let index = 0; index < total; index += 1) {
    const tail = new Uint8Array(TAIL_LENGTH);
    tail.set(encodePosition(index + 1, total), 0);
    new DataView(tail.buffer).setBigUint64(LENGTH_FIELD_OFFSET, BigInt(message.byteLength), true);
    tail.set(
      message.subarray(index * PART_DATA_LENGTH, (index + 1) * PART_DATA_LENGTH),
      DATA_OFFSET,
    );
    hash.update(tail);
    parts.push({ position: index + 1, total, tail });
  }
  return { requestId: Uint8Array.from(hash.digest()), messageLength: message.byteLength, parts };
};

/** The event name the circuit emits for a tail: prefix, tail bytes 0..7, 11 zeros. */
export const eventNameFor = (tail: Uint8Array): Uint8Array => {
  if (tail.byteLength !== TAIL_LENGTH) throw new RangeError("tail must be 224 bytes");
  const name = new Uint8Array(NAME_LENGTH);
  name.set(namePrefix(), 0);
  name.set(tail.subarray(0, POSITION_FIELD_LENGTH), NAME_POSITION_OFFSET);
  return name;
};

/** The event payload the circuit emits: request ID followed by the tail. */
export const eventPayloadFor = (requestId: Uint8Array, tail: Uint8Array): Uint8Array => {
  if (requestId.byteLength !== REQUEST_ID_LENGTH)
    throw new RangeError("request ID must be 32 bytes");
  if (tail.byteLength !== TAIL_LENGTH) throw new RangeError("tail must be 224 bytes");
  const payload = new Uint8Array(PAYLOAD_LENGTH);
  payload.set(requestId, 0);
  payload.set(tail, REQUEST_ID_LENGTH);
  return payload;
};

/** The full 288-byte event value (name then payload) for a part. */
export const eventValueFor = (requestId: Uint8Array, tail: Uint8Array): Uint8Array => {
  const value = new Uint8Array(NAME_LENGTH + PAYLOAD_LENGTH);
  value.set(eventNameFor(tail), 0);
  value.set(eventPayloadFor(requestId, tail), NAME_LENGTH);
  return value;
};
