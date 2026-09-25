/**
 * Protected secret files: creation with O_EXCL and mode 0600 under umask 077, refusal
 * to overwrite, to read group/other-accessible files or symlinks, and to place secrets
 * inside a Git working tree; error messages never contain file contents.
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createWitnessSecretFile,
  enclosingRepository,
  readProtectedFile,
  readSigningKeyFile,
  readWitnessSecret,
  SecretFileError,
  writeSecretFile,
  writeSigningKeyFile,
} from "../deploy-tools/secrets.js";

let dir: string;
let previousUmask: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cmse-secrets-"));
  previousUmask = process.umask(0o022);
});

afterEach(() => {
  process.umask(previousUmask);
});

const message = (run: () => unknown): string => {
  try {
    run();
    return "accepted";
  } catch (error) {
    expect(error).toBeInstanceOf(SecretFileError);
    return (error as Error).message;
  }
};

describe("witness secret files", () => {
  it("creates a 32-byte secret with mode 0600 under a permissive caller umask, and reads it back", () => {
    const path = join(dir, "nested", "emitter.secret");
    createWitnessSecretFile(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "nested")).mode & 0o777).toBe(0o700);
    const text = readFileSync(path, "utf8");
    expect(text).toMatch(/^[0-9a-f]{64}\n$/);
    const secret = readWitnessSecret(path);
    expect(secret).toHaveLength(32);
    expect(Buffer.from(secret).toString("hex")).toBe(text.trim());
    expect(process.umask()).toBe(0o022);
  });

  it("two secrets differ", () => {
    createWitnessSecretFile(join(dir, "a"));
    createWitnessSecretFile(join(dir, "b"));
    expect(readWitnessSecret(join(dir, "a"))).not.toEqual(readWitnessSecret(join(dir, "b")));
  });

  it("refuses to overwrite an existing file", () => {
    const path = join(dir, "emitter.secret");
    createWitnessSecretFile(path);
    const before = readFileSync(path, "utf8");
    expect(message(() => createWitnessSecretFile(path))).toContain("already exists");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("refuses a location inside a Git working tree unless allowed (tests)", () => {
    const repository = join(dir, "repo");
    mkdirSync(join(repository, ".git"), { recursive: true });
    mkdirSync(join(repository, "sub"));
    expect(enclosingRepository(join(repository, "sub", "x"))).toBe(repository);
    expect(message(() => createWitnessSecretFile(join(repository, "sub", "s")))).toContain(
      "inside the Git working tree",
    );
    createWitnessSecretFile(join(repository, "sub", "s"), { allowInsideRepository: true });
    expect(readWitnessSecret(join(repository, "sub", "s"))).toHaveLength(32);
  });

  it("refuses group- or other-accessible files, symlinks, empty and malformed files, without printing contents", () => {
    const secretText = "ab".repeat(32);
    const open = join(dir, "open.secret");
    writeFileSync(open, `${secretText}\n`);
    chmodSync(open, 0o644);
    const openMessage = message(() => readWitnessSecret(open));
    expect(openMessage).toContain("chmod 600");
    expect(openMessage).not.toContain(secretText);

    chmodSync(open, 0o600);
    const link = join(dir, "link.secret");
    symlinkSync(open, link);
    expect(message(() => readWitnessSecret(link))).toContain("symbolic link");

    const empty = join(dir, "empty");
    writeFileSync(empty, "", { mode: 0o600 });
    expect(message(() => readProtectedFile(empty))).toContain("is empty");

    const malformed = join(dir, "malformed");
    const malformedText = "not-a-secret-but-private-text";
    writeFileSync(malformed, malformedText, { mode: 0o600 });
    const malformedMessage = message(() => readWitnessSecret(malformed));
    expect(malformedMessage).toContain("64 lowercase hex");
    expect(malformedMessage).not.toContain(malformedText);

    expect(message(() => readWitnessSecret(join(dir, "missing")))).toContain("ENOENT");
    expect(message(() => readWitnessSecret(dir))).toContain("not a regular file");
  });

  it("stores and reads a maintenance signing key file; rejects other JSON", () => {
    const path = join(dir, "maintenance.json");
    writeSigningKeyFile(path, { tag: "schnorr", value: "cd".repeat(32) });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readSigningKeyFile(path)).toEqual({ tag: "schnorr", value: "cd".repeat(32) });
    const other = join(dir, "other.json");
    writeSecretFile(other, '{"kind":"something-else"}');
    expect(message(() => readSigningKeyFile(other))).toContain("not a maintenance signing key");
    const text = join(dir, "text.json");
    writeSecretFile(text, "private words");
    const textMessage = message(() => readSigningKeyFile(text));
    expect(textMessage).toContain("not JSON");
    expect(textMessage).not.toContain("private words");
  });
});
