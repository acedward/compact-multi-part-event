/**
 * Zero-knowledge artifact (key) adapter.
 *
 * Proving needs, per circuit, the prover key, verifier key and ZKIR produced by
 * `compactc` (`yarn compile:zk` writes them under `build/zk/<contract>`). The prover
 * resolves a call's key location `contract:<address>/<entryPoint>?vk=<sha256>` by the
 * verifier-key hash, so the local verifier key must equal the deployed one byte for
 * byte. This module checks that before any proof request, and checks artifact hashes
 * against a committed `SHA256SUMS` file, so a stale or foreign build fails early with
 * a clear message instead of `ZKArtifactNotFoundError` after proving started.
 *
 * @module
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { NodeZkConfigProvider } from "@midnight-ntwrk/midnight-js-node-zk-config-provider";

/** A mismatch between local artifacts and what is expected. */
export class ArtifactMismatchError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "ArtifactMismatchError";
  }
}

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Path of a circuit's verifier key in a `compactc` output directory. */
export const verifierKeyPath = (artifactDir: string, circuit: string): string =>
  join(artifactDir, "keys", `${circuit}.verifier`);

/** Read a circuit's verifier key from a `compactc` output directory. */
export const readVerifierKey = (artifactDir: string, circuit: string): Uint8Array => {
  const path = verifierKeyPath(artifactDir, circuit);
  if (!existsSync(path)) throw new ArtifactMismatchError(`no verifier key at ${path}`);
  return new Uint8Array(readFileSync(path));
};

/** Parse a `sha256sum` listing (`<hash>  <relative path>` per line). */
export const parseSha256Sums = (text: string): Map<string, string> => {
  const sums = new Map<string, string>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(trimmed);
    if (match?.[1] === undefined || match[2] === undefined) {
      throw new ArtifactMismatchError(`malformed SHA256SUMS line: ${trimmed}`);
    }
    sums.set(match[2], match[1]);
  }
  return sums;
};

/**
 * Check every file listed in `sha256SumsPath` inside `artifactDir`.
 *
 * @returns The checked relative paths.
 * @throws {ArtifactMismatchError} On a missing file or a different hash.
 */
export const checkArtifactHashes = (artifactDir: string, sha256SumsPath: string): string[] => {
  const sums = parseSha256Sums(readFileSync(sha256SumsPath, "utf8"));
  for (const [relative, expected] of sums) {
    const path = join(artifactDir, relative);
    if (!existsSync(path)) throw new ArtifactMismatchError(`missing artifact ${path}`);
    const actual = sha256Hex(readFileSync(path));
    if (actual !== expected) {
      throw new ArtifactMismatchError(
        `${relative}: SHA-256 ${actual} differs from ${expected} in ${sha256SumsPath}`,
      );
    }
  }
  return [...sums.keys()];
};

/**
 * Require a local verifier key to equal an expected one (the deployed key, or the
 * repository's committed key).
 *
 * @throws {ArtifactMismatchError} Naming both SHA-256 values.
 */
export const assertVerifierKeyEquals = (
  local: Uint8Array,
  expected: Uint8Array,
  label: string,
): void => {
  if (local.byteLength !== expected.byteLength || !local.every((b, i) => b === expected[i])) {
    throw new ArtifactMismatchError(
      `${label}: verifier key SHA-256 ${sha256Hex(local)} differs from the expected ${sha256Hex(expected)}`,
    );
  }
};

/** Options for {@link zkConfigForContract}. */
export interface ZkConfigOptions {
  /** `compactc` output directory with `keys/` and `zkir/` (e.g. `build/zk/emitter`). */
  readonly artifactDir: string;
  /** Circuits that will be proven, each with the verifier key it must have. */
  readonly expectedVerifierKeys?: Readonly<Record<string, Uint8Array>>;
  /** Optional `SHA256SUMS` listing to check the artifacts against first. */
  readonly sha256SumsPath?: string;
}

/**
 * A midnight-js zk-config provider over a `compactc` output directory, after checking
 * the artifacts: listed hashes, and each expected verifier key.
 */
export const zkConfigForContract = (options: ZkConfigOptions): NodeZkConfigProvider<string> => {
  if (!existsSync(join(options.artifactDir, "keys"))) {
    throw new ArtifactMismatchError(
      `${options.artifactDir} has no keys/ directory; run the full key build (yarn compile:zk)`,
    );
  }
  if (options.sha256SumsPath !== undefined) {
    checkArtifactHashes(options.artifactDir, options.sha256SumsPath);
  }
  for (const [circuit, expected] of Object.entries(options.expectedVerifierKeys ?? {})) {
    assertVerifierKeyEquals(readVerifierKey(options.artifactDir, circuit), expected, circuit);
  }
  return new NodeZkConfigProvider<string>(options.artifactDir);
};

/** SHA-256 hex of a verifier key, as recorded in evidence. */
export const verifierKeyHash = (key: Uint8Array): string => sha256Hex(key);
