import { createHash } from "node:crypto";

/** Deterministic test bytes: byte i = (i * 37 + 11 + seed) mod 256. */
export const patternMessage = (length: number, seed = 0): Uint8Array =>
  Uint8Array.from({ length }, (_, index) => (index * 37 + 11 + seed) & 0xff);

/** Deterministic non-periodic bytes derived from a label (SHA-256 chain). */
export const hashedBytes = (length: number, label: string): Uint8Array => {
  const out = new Uint8Array(length);
  let block = createHash("sha256").update(label).digest();
  for (let offset = 0; offset < length; offset += 32) {
    out.set(block.subarray(0, Math.min(32, length - offset)), offset);
    block = createHash("sha256").update(block).digest();
  }
  return out;
};

export const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

export const fromHex = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, "hex"));

export const sha256 = (...chunks: readonly Uint8Array[]): Uint8Array => {
  const hash = createHash("sha256");
  for (const chunk of chunks) hash.update(chunk);
  return Uint8Array.from(hash.digest());
};

export const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);

/** A 32-byte value filled with one byte (handy distinct secrets). */
export const filled32 = (byte: number): Uint8Array => new Uint8Array(32).fill(byte);

/** `count` deterministic 256-byte parts, each distinct (part k starts with the byte k). */
export const patternParts = (count: number, seed = 0): Uint8Array[] =>
  Array.from({ length: count }, (_, index) => {
    const part = patternMessage(256, seed * 131 + index * 17);
    part[0] = index + 1;
    return part;
  });

/** A 256-byte part: `prefix` then zero bytes (so the ledger trims its trailing zeros). */
export const shortPart = (prefix: Uint8Array): Uint8Array => {
  const part = new Uint8Array(256);
  part.set(prefix);
  return part;
};

/** Concatenate byte arrays into one Uint8Array. */
export const concatBytes = (chunks: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
};
