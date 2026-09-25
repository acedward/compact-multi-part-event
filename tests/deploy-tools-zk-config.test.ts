/**
 * Zero-knowledge artifact adapter: SHA256SUMS parsing and checking, verifier-key
 * equality with both hashes in the message, and refusal of an artifact directory
 * without keys or with a key other than the expected one.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ArtifactMismatchError,
  assertVerifierKeyEquals,
  checkArtifactHashes,
  parseSha256Sums,
  readVerifierKey,
  zkConfigForContract,
} from "../deploy-tools/zk-config.js";
import { EMITTER_VERIFIER_KEY, repoFile } from "./helpers/generated.js";

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const artifactDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "cmse-zk-"));
  mkdirSync(join(dir, "keys"));
  mkdirSync(join(dir, "zkir"));
  writeFileSync(join(dir, "keys/emitPart.verifier"), EMITTER_VERIFIER_KEY);
  writeFileSync(join(dir, "zkir/emitPart.zkir"), "zkir");
  const sums = join(dir, "SHA256SUMS");
  writeFileSync(
    sums,
    `${sha(EMITTER_VERIFIER_KEY)}  keys/emitPart.verifier\n${sha(Buffer.from("zkir"))}  zkir/emitPart.zkir\n`,
  );
  return { dir, sums };
};

describe("artifact hashes", () => {
  it("parses the committed SHA256SUMS of the reference emitter", async () => {
    const { readFileSync } = await import("node:fs");
    const sums = parseSha256Sums(
      readFileSync(repoFile("contract-examples/emitter/keys/SHA256SUMS"), "utf8"),
    );
    expect([...sums.keys()].sort()).toEqual([
      "keys/emitPart.prover",
      "keys/emitPart.verifier",
      "zkir/emitPart.bzkir",
      "zkir/emitPart.zkir",
    ]);
    expect(sums.get("keys/emitPart.verifier")).toBe(sha(EMITTER_VERIFIER_KEY));
  });

  it("checks every listed file and names the one that differs or is missing", () => {
    const { dir, sums } = artifactDir();
    expect(checkArtifactHashes(dir, sums)).toEqual([
      "keys/emitPart.verifier",
      "zkir/emitPart.zkir",
    ]);
    writeFileSync(join(dir, "zkir/emitPart.zkir"), "changed");
    expect(() => checkArtifactHashes(dir, sums)).toThrow(/zkir\/emitPart.zkir: SHA-256/);
    const empty = mkdtempSync(join(tmpdir(), "cmse-zk-empty-"));
    expect(() => checkArtifactHashes(empty, sums)).toThrow(/missing artifact/);
    writeFileSync(join(dir, "BAD"), "not a sum line\n");
    expect(() => parseSha256Sums("nonsense")).toThrow(ArtifactMismatchError);
  });
});

describe("verifier keys", () => {
  it("compares keys byte for byte and reports both hashes", () => {
    assertVerifierKeyEquals(EMITTER_VERIFIER_KEY, new Uint8Array(EMITTER_VERIFIER_KEY), "emitPart");
    const other = new Uint8Array(EMITTER_VERIFIER_KEY);
    other[100] = (other[100] ?? 0) ^ 1;
    expect(() => assertVerifierKeyEquals(other, EMITTER_VERIFIER_KEY, "emitPart")).toThrow(
      new RegExp(`${sha(other)} differs from the expected ${sha(EMITTER_VERIFIER_KEY)}`),
    );
  });

  it("builds a zk-config provider only over a directory with the expected keys", () => {
    const { dir, sums } = artifactDir();
    expect(readVerifierKey(dir, "emitPart")).toEqual(EMITTER_VERIFIER_KEY);
    const provider = zkConfigForContract({
      artifactDir: dir,
      expectedVerifierKeys: { emitPart: EMITTER_VERIFIER_KEY },
      sha256SumsPath: sums,
    });
    expect(provider.directory).toBe(dir);
    expect(() =>
      zkConfigForContract({
        artifactDir: dir,
        expectedVerifierKeys: { emitPart: new Uint8Array(3) },
      }),
    ).toThrow(/differs from the expected/);
    expect(() => zkConfigForContract({ artifactDir: mkdtempSync(join(tmpdir(), "x-")) })).toThrow(
      /no keys\/ directory/,
    );
    expect(() => readVerifierKey(dir, "missing")).toThrow(/no verifier key/);
  });
});
