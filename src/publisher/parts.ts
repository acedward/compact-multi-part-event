/**
 * Split an adopting protocol's payload into 256-byte parts, one per call of the
 * emitting circuit. The last part is zero-padded, so the adopting protocol's format
 * must be readable at any multiple of 256 bytes (it carries its own length, type or
 * checksum if it needs one).
 *
 * @module
 */
import { PAYLOAD_LENGTH } from "../reader/event.js";

/** Width of one part: the payload of one `Misc` event. */
export const PART_LENGTH = PAYLOAD_LENGTH;

/** Number of parts a payload of `length` bytes needs. */
export const partCountFor = (length: number): number => Math.ceil(length / PART_LENGTH);

/**
 * Split a payload into 256-byte parts, zero-padding the last one.
 *
 * @throws {RangeError} If the payload is empty (a package has at least one part).
 */
export const splitPayload = (payload: Uint8Array): Uint8Array[] => {
  if (payload.byteLength === 0) throw new RangeError("the payload is empty");
  return Array.from({ length: partCountFor(payload.byteLength) }, (_, index) => {
    const part = new Uint8Array(PART_LENGTH);
    part.set(payload.subarray(index * PART_LENGTH, (index + 1) * PART_LENGTH));
    return part;
  });
};
