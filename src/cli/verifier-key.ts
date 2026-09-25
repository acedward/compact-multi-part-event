/**
 * Verifier keys: the comparison verification Level 3 makes (the deployed key of the
 * emitting circuit equals the repository's committed key, which the check entry point
 * regenerates from source), and the byte-for-byte equality the proving configuration
 * of this repository's deploy-tools requires before any proof request.
 *
 * @module
 */
import { createHash } from "node:crypto";

import * as ledger from "@midnightntwrk/ledger-v9";

import { bytesEqual } from "../reader/bytes.js";

/** SHA-256 hex of a verifier key. */
export const verifierKeySha256 = (key: Uint8Array): string =>
  createHash("sha256").update(key).digest("hex");

/** Two verifier keys differ. The message names both SHA-256 values. */
export class VerifierKeyMismatchError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "VerifierKeyMismatchError";
  }
}

/**
 * Require a verifier key to equal an expected one, byte for byte.
 *
 * @throws {VerifierKeyMismatchError} Naming both SHA-256 values.
 */
export const assertVerifierKeyEquals = (
  actual: Uint8Array,
  expected: Uint8Array,
  label: string,
): void => {
  if (!bytesEqual(actual, expected)) {
    throw new VerifierKeyMismatchError(
      `${label}: verifier key SHA-256 ${verifierKeySha256(actual)} differs from the expected ${verifierKeySha256(expected)}`,
    );
  }
};

/**
 * The verifier key a serialized contract state stores for an entry point.
 *
 * @returns The key, or `undefined` when the state has no such operation or key.
 * @throws {Error} If the bytes are not a ledger-v9 contract state.
 */
export const deployedVerifierKey = (
  stateBytes: Uint8Array,
  entryPoint: string,
): Uint8Array | undefined => {
  const key = ledger.ContractState.deserialize(stateBytes).operation(entryPoint)?.verifierKey;
  return key === undefined || key.byteLength === 0 ? undefined : key;
};

/** Outcome of {@link compareDeployedVerifierKey}. */
export interface VerifierKeyComparison {
  readonly ok: boolean;
  /** SHA-256 of the deployed key, when there is one. */
  readonly deployedSha256?: string;
  readonly expectedSha256: string;
}

/**
 * Compare the deployed verifier key of `entryPoint` in a serialized contract state with
 * the expected (committed) key.
 */
export const compareDeployedVerifierKey = (
  stateBytes: Uint8Array,
  entryPoint: string,
  expected: Uint8Array,
): VerifierKeyComparison => {
  const deployed = deployedVerifierKey(stateBytes, entryPoint);
  const expectedSha256 = verifierKeySha256(expected);
  if (deployed === undefined) return { ok: false, expectedSha256 };
  return {
    ok: bytesEqual(deployed, expected),
    deployedSha256: verifierKeySha256(deployed),
    expectedSha256,
  };
};
