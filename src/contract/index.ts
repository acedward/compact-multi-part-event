/**
 * Client-side helpers for the two example access controls in `contracts/modules/`.
 *
 * Neither access control is part of the event format. `EmitterWhitelist` lets one
 * emitter publish (the reference emitter uses it); `MessageRegistry` gives each
 * registered message its own owner, for contracts that let several users emit.
 *
 * The witness secrets these helpers handle are private proof inputs: keep them in
 * protected storage, never log them, and only send them to a proof server you run.
 *
 * Both examples rank below the contract's maintenance authority, which can delete
 * every circuit and install new ones (for example an `emitPart` without the check).
 * A reader who trusts events because only the whitelisted secret can emit is also
 * trusting whoever holds that authority.
 *
 * @module
 */
import { createHash } from "node:crypto";

/** Domain tag of `EmitterWhitelist.emitterAuthorityOf`, before zero padding to 32 bytes. */
export const EMITTER_AUTHORITY_TAG = "example:emitter-authority:v1";

/** Domain tag of `MessageRegistry.messageOwnerOf`, before zero padding to 32 bytes. */
export const MESSAGE_OWNER_TAG = "example:message-owner:v1";

/** Width of a witness secret and of its public commitment. */
export const SECRET_LENGTH = 32;

const paddedTag = (tag: string): Uint8Array => {
  const encoded = new TextEncoder().encode(tag);
  if (encoded.byteLength > SECRET_LENGTH) throw new RangeError("domain tag exceeds 32 bytes");
  const out = new Uint8Array(SECRET_LENGTH);
  out.set(encoded);
  return out;
};

const assertSecret = (secret: Uint8Array): void => {
  if (secret.byteLength !== SECRET_LENGTH) {
    throw new RangeError(`secret must be ${String(SECRET_LENGTH)} bytes`);
  }
};

/**
 * Compact `persistentHash<Vector<2, Bytes<32>>>([pad(32, tag), secret])`, which is
 * SHA-256 over the 64 concatenated bytes.
 */
const commitment = (tag: string, secret: Uint8Array): Uint8Array => {
  assertSecret(secret);
  return Uint8Array.from(createHash("sha256").update(paddedTag(tag)).update(secret).digest());
};

/**
 * Public commitment the reference emitter's constructor stores; equal to the
 * contract's pure circuit `emitterAuthorityOf(secret)`.
 *
 * @param secret - The emitter's 32-byte witness secret.
 * @returns The 32-byte authority commitment.
 */
export const emitterAuthorityOf = (secret: Uint8Array): Uint8Array =>
  commitment(EMITTER_AUTHORITY_TAG, secret);

/**
 * Owner commitment `MessageRegistry.registerMessage` stores; equal to the
 * contract's pure circuit `messageOwnerOf(secret)`.
 *
 * @param secret - The owner's 32-byte witness secret.
 * @returns The 32-byte owner commitment.
 */
export const messageOwnerOf = (secret: Uint8Array): Uint8Array =>
  commitment(MESSAGE_OWNER_TAG, secret);

/** Private state that answers the `emitterSecret` witness. */
export interface EmitterPrivateState {
  readonly emitterSecret: Uint8Array;
}

/** Private state that answers the `messageOwnerSecret` witness. */
export interface MessageOwnerPrivateState {
  readonly messageOwnerSecret: Uint8Array;
}

/** The part of a Compact witness context these witnesses read. */
export interface WitnessInput<PS> {
  readonly privateState: PS;
}

/** Witness implementation for contracts that import `EmitterWhitelist`. */
export const emitterWitnesses = {
  emitterSecret<PS extends EmitterPrivateState>({
    privateState,
  }: WitnessInput<PS>): [PS, Uint8Array] {
    assertSecret(privateState.emitterSecret);
    return [privateState, privateState.emitterSecret];
  },
};

/** Witness implementation for contracts that import `MessageRegistry`. */
export const messageOwnerWitnesses = {
  messageOwnerSecret<PS extends MessageOwnerPrivateState>({
    privateState,
  }: WitnessInput<PS>): [PS, Uint8Array] {
    assertSecret(privateState.messageOwnerSecret);
    return [privateState, privateState.messageOwnerSecret];
  },
};
