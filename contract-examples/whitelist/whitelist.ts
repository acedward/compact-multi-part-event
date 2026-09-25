/**
 * Off-chain helper for the example access control `EmitterWhitelist.compact`: the
 * commitment the constructor stores, and the witness that answers `emitterSecret`.
 *
 * The access control is not part of the multi-part rule. It lets one emitter publish,
 * and it ranks below the contract's maintenance authority, which can remove every
 * circuit and install new ones (for example an `emitPart` without the check). A reader
 * who trusts events because only the whitelisted secret can emit also trusts whoever
 * holds that authority.
 *
 * The witness secret is a private proof input: keep it in protected storage, never log
 * it, and only send it to a proof server you run.
 *
 * @module
 */
import { createHash } from "node:crypto";

/** Domain tag of `emitterAuthorityOf`, before zero padding to 32 bytes. */
export const EMITTER_AUTHORITY_TAG = "example:emitter-authority:v1";

/** Width of the witness secret and of its public commitment. */
export const SECRET_LENGTH = 32;

const paddedTag = (): Uint8Array => {
  const out = new Uint8Array(SECRET_LENGTH);
  out.set(new TextEncoder().encode(EMITTER_AUTHORITY_TAG));
  return out;
};

const assertSecret = (secret: Uint8Array): void => {
  if (secret.byteLength !== SECRET_LENGTH) {
    throw new RangeError(`secret must be ${String(SECRET_LENGTH)} bytes`);
  }
};

/**
 * Public commitment the constructor stores: Compact's
 * `persistentHash<Vector<2, Bytes<32>>>([pad(32, tag), secret])`, which is SHA-256 over
 * the 64 concatenated bytes; equal to the contract's pure circuit
 * `emitterAuthorityOf(secret)`.
 *
 * @param secret - The emitter's 32-byte witness secret.
 * @returns The 32-byte authority commitment.
 */
export const emitterAuthorityOf = (secret: Uint8Array): Uint8Array => {
  assertSecret(secret);
  return Uint8Array.from(createHash("sha256").update(paddedTag()).update(secret).digest());
};

/** Private state that answers the `emitterSecret` witness. */
export interface EmitterPrivateState {
  readonly emitterSecret: Uint8Array;
}

/** The part of a Compact witness context the witness reads. */
export interface WitnessInput<PS> {
  readonly privateState: PS;
}

/** Witness implementation for every contract that imports `EmitterWhitelist`. */
export const emitterWitnesses = {
  emitterSecret<PS extends EmitterPrivateState>({
    privateState,
  }: WitnessInput<PS>): [PS, Uint8Array] {
    assertSecret(privateState.emitterSecret);
    return [privateState, privateState.emitterSecret];
  },
};
