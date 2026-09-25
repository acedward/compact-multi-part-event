/** Small byte helpers shared by the reader and the publisher (no dependencies). */

export const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
};

const HEX_DIGITS = "0123456789abcdef";

/** Lowercase hex without a prefix. */
export const bytesToHex = (bytes: Uint8Array): string => {
  let out = "";
  for (const byte of bytes) out += (HEX_DIGITS[byte >> 4] ?? "") + (HEX_DIGITS[byte & 15] ?? "");
  return out;
};

/**
 * Strict hex decoding: even length, digits `0-9a-fA-F` only, no `0x` prefix.
 *
 * @throws {RangeError} On any other input.
 */
export const hexToBytes = (hex: string): Uint8Array => {
  if (hex.length % 2 !== 0) throw new RangeError("hex string has odd length");
  if (!/^[0-9a-fA-F]*$/.test(hex)) throw new RangeError("hex string has non-hex characters");
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.byteLength; index += 1) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
};

/** Code-unit string order, independent of locale (unlike `localeCompare`). */
export const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
