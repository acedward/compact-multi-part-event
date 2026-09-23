import { createHash } from "node:crypto";

/** Deterministic test message: byte i = (i * 37 + 11 + seed) mod 256. */
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

/**
 * Test-local tail construction straight from the normative wire table (not the
 * library writer): "p:n" ASCII in bytes 0..7, length u64 LE in 8..15, 208 data
 * bytes in 16..223, zero padding.
 */
export const specTails = (message: Uint8Array): Uint8Array[] => {
  const total = Math.max(1, Math.ceil(message.byteLength / 208));
  return Array.from({ length: total }, (_, index) => {
    const tail = new Uint8Array(224);
    tail.set(ascii(`${String(index + 1)}:${String(total)}`), 0);
    new DataView(tail.buffer).setBigUint64(8, BigInt(message.byteLength), true);
    tail.set(message.subarray(index * 208, (index + 1) * 208), 16);
    return tail;
  });
};

/** 32-byte event name for part `p` of `n`, from the normative wire table. */
export const specName = (position: number, total: number): Uint8Array => {
  const name = new Uint8Array(32);
  name.set(ascii(`mip-xxxx[v1]:${String(position)}:${String(total)}`), 0);
  return name;
};
