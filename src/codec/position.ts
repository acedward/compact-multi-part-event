/**
 * The 8-byte position field (tail bytes 0..7): ASCII `ppp:nnn` — the 1-based part
 * number and the total number of parts, each exactly three decimal digits,
 * zero-padded (part 1 of 10 is `001:010`), `001 <= ppp <= nnn <= 999` — followed by
 * one zero byte.
 *
 * @module
 */
import { FORMAT_MAX_PARTS, POSITION_FIELD_LENGTH } from "./constants.js";

/** Decoded position field. */
export interface PartPosition {
  /** 1-based part number. */
  readonly position: number;
  /** Total number of parts. */
  readonly total: number;
}

const DIGIT_0 = 0x30;
const DIGIT_9 = 0x39;
const COLON = 0x3a;

const threeDigits = (value: number): string => String(value).padStart(3, "0");

/**
 * Encode `ppp:nnn` into the 8-byte field.
 *
 * @throws {RangeError} If `1 <= position <= total <= 999` does not hold.
 */
export const encodePosition = (position: number, total: number): Uint8Array => {
  if (
    !Number.isSafeInteger(position) ||
    !Number.isSafeInteger(total) ||
    position < 1 ||
    position > total ||
    total > FORMAT_MAX_PARTS
  ) {
    throw new RangeError(`invalid part position ${String(position)} of ${String(total)}`);
  }
  const field = new Uint8Array(POSITION_FIELD_LENGTH);
  field.set(new TextEncoder().encode(`${threeDigits(position)}:${threeDigits(total)}`));
  return field;
};

const readThreeDigits = (field: Uint8Array, start: number, label: string): number => {
  let value = 0;
  for (let index = start; index < start + 3; index += 1) {
    const byte = field[index] ?? 0;
    if (byte < DIGIT_0 || byte > DIGIT_9) {
      throw new RangeError(`position field: ${label} is not three ASCII digits`);
    }
    value = value * 10 + (byte - DIGIT_0);
  }
  return value;
};

/**
 * Strictly decode the 8-byte position field.
 *
 * @throws {RangeError} If the field is not exactly `ppp:nnn` followed by a zero byte
 * with `001 <= ppp <= nnn`.
 */
export const decodePosition = (field: Uint8Array): PartPosition => {
  if (field.byteLength !== POSITION_FIELD_LENGTH) {
    throw new RangeError(`position field must be ${String(POSITION_FIELD_LENGTH)} bytes`);
  }
  const position = readThreeDigits(field, 0, "part number");
  if (field[3] !== COLON) throw new RangeError("position field: byte 3 is not a colon");
  const total = readThreeDigits(field, 4, "part total");
  if (field[7] !== 0) throw new RangeError("position field: byte 7 is not zero");
  if (position === 0) throw new RangeError("position field: part number is 000");
  if (total === 0) throw new RangeError("position field: part total is 000");
  if (position > total) throw new RangeError("position field: part number exceeds the total");
  return { position, total };
};
