/**
 * Protected secret files: witness secrets (`emitterSecret`, `messageOwnerSecret`),
 * maintenance signing keys and the wallet mnemonic are referenced by PATH only.
 *
 * Rules enforced here:
 * - files are created with umask 077, `O_CREAT | O_EXCL` (never overwritten) and mode
 *   0600, then read back and compared;
 * - files are read only if they are regular files (not symlinks) that neither group
 *   nor others can access;
 * - secret files must live outside every Git working tree;
 * - no error message, return value meant for printing, or log line contains the
 *   secret bytes or any part of the file.
 *
 * @module
 */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Width of a Compact witness secret. */
export const WITNESS_SECRET_LENGTH = 32;

/** Largest secret file this module reads (a 24-word mnemonic is about 200 bytes). */
const MAX_SECRET_FILE_BYTES = 4096;

/** A problem with a secret file. The message never contains file contents. */
export class SecretFileError extends Error {
  constructor(
    readonly path: string,
    detail: string,
  ) {
    super(`secret file ${path}: ${detail}`);
    this.name = "SecretFileError";
  }
}

/** The Git working tree that contains `path`, if any (a `.git` entry in it or a parent). */
export const enclosingRepository = (path: string): string | undefined => {
  let current = resolve(path);
  for (;;) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
};

const assertOutsideRepository = (path: string): void => {
  const repository = enclosingRepository(dirname(resolve(path)));
  if (repository !== undefined) {
    throw new SecretFileError(
      path,
      `refusing a secret path inside the Git working tree ${repository}; use a directory outside every repository`,
    );
  }
};

/** Options for {@link createSecretFile}. */
export interface CreateSecretOptions {
  /** Allow a path inside a Git working tree (tests only). Default false. */
  readonly allowInsideRepository?: boolean;
}

/**
 * Create a new protected file holding `content` (UTF-8 text). Refuses to overwrite an
 * existing file. Creates the parent directory with mode 0700 if it does not exist.
 *
 * @throws {SecretFileError} If the file exists, the location is inside a Git working
 * tree, or the read-back differs.
 */
export const writeSecretFile = (
  path: string,
  content: string,
  options: CreateSecretOptions = {},
): void => {
  if (options.allowInsideRepository !== true) assertOutsideRepository(path);
  const previous = process.umask(0o077);
  try {
    const parent = dirname(resolve(path));
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
    let fd: number;
    try {
      fd = openSync(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "error";
      throw new SecretFileError(
        path,
        code === "EEXIST" ? "already exists; refusing to overwrite it" : `cannot create (${code})`,
      );
    }
    try {
      writeSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } finally {
    process.umask(previous);
  }
  if (readProtectedFile(path) !== content) {
    throw new SecretFileError(path, "read-back differs from what was written");
  }
};

/**
 * Read a protected file as UTF-8 text.
 *
 * @throws {SecretFileError} If it is missing, not a regular file, a symlink, readable
 * or writable by group or others, empty, or too large.
 */
export const readProtectedFile = (path: string): string => {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    throw new SecretFileError(
      path,
      `cannot be read (${(error as NodeJS.ErrnoException).code ?? "error"})`,
    );
  }
  if (stats.isSymbolicLink()) throw new SecretFileError(path, "is a symbolic link");
  if (!stats.isFile()) throw new SecretFileError(path, "is not a regular file");
  if ((stats.mode & 0o077) !== 0) {
    throw new SecretFileError(
      path,
      `mode ${(stats.mode & 0o777).toString(8)} lets group or others access it; run chmod 600`,
    );
  }
  if (stats.size === 0) throw new SecretFileError(path, "is empty");
  if (stats.size > MAX_SECRET_FILE_BYTES) throw new SecretFileError(path, "is too large");
  return readFileSync(path, "utf8");
};

/**
 * Generate a new 32-byte witness secret into a protected file (64 lowercase hex
 * characters and a newline). The secret is not returned: callers read it back with
 * {@link readWitnessSecret} when they need it, and never print it.
 */
export const createWitnessSecretFile = (path: string, options: CreateSecretOptions = {}): void => {
  const secret = randomBytes(WITNESS_SECRET_LENGTH);
  try {
    writeSecretFile(path, `${secret.toString("hex")}\n`, options);
  } finally {
    secret.fill(0);
  }
};

/**
 * Read a 32-byte witness secret written by {@link createWitnessSecretFile}.
 *
 * @throws {SecretFileError} On any file or format problem (without revealing content).
 */
export const readWitnessSecret = (path: string): Uint8Array => {
  const text = readProtectedFile(path).trim();
  if (!/^[0-9a-f]{64}$/.test(text)) {
    throw new SecretFileError(path, "does not hold exactly 64 lowercase hex characters");
  }
  return Uint8Array.from(Buffer.from(text, "hex"));
};

/** A ledger signing key as stored in a protected file. */
export interface StoredSigningKey {
  readonly tag: string;
  readonly value: string;
}

/** Write a maintenance signing key (`{ tag, value }`) into a new protected JSON file. */
export const writeSigningKeyFile = (
  path: string,
  key: StoredSigningKey,
  options: CreateSecretOptions = {},
): void => {
  writeSecretFile(
    path,
    `${JSON.stringify({ kind: "maintenance-signing-key", tag: key.tag, value: key.value })}\n`,
    options,
  );
};

/** Read a maintenance signing key written by {@link writeSigningKeyFile}. */
export const readSigningKeyFile = (path: string): StoredSigningKey => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readProtectedFile(path));
  } catch (error) {
    if (error instanceof SecretFileError) throw error;
    throw new SecretFileError(path, "is not JSON");
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.kind !== "maintenance-signing-key" ||
    typeof record.tag !== "string" ||
    typeof record.value !== "string"
  ) {
    throw new SecretFileError(path, "is not a maintenance signing key file");
  }
  return { tag: record.tag, value: record.value };
};
