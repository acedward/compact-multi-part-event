/**
 * Optional wallet-state cache: the three sub-wallets' serialized states
 * (wallet-sdk 5.0.0-beta.2 `serializeState`/`restore`), saved after a complete sync so
 * the next run resumes from there instead of downloading every ledger event again.
 *
 * The snapshots hold no signing key or seed, but they do hold private wallet data (the
 * wallet's coins, UTxOs and DUST state), so the file gets the same protection as a
 * secret file: mode 0600, a regular file (never a symlink), outside every Git working
 * tree, never printed. It is replaced atomically (temporary file, then rename).
 *
 * The file is an envelope that names the wallet's public identity and the SDK the
 * snapshots come from:
 * - a missing file is created after the first complete sync;
 * - a cache of another wallet or network is refused (it is never overwritten);
 * - a file that is not a cache at all is refused and never overwritten (so a mistyped
 *   path cannot destroy, say, the mnemonic file);
 * - a cache written by another SDK version is ignored (full sync) and then replaced.
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
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { enclosingRepository } from "./secrets.js";

/** `kind` of a cache envelope. */
export const WALLET_CACHE_KIND = "cmse-wallet-state-cache";
/** Envelope format version. */
export const WALLET_CACHE_VERSION = 1;
/** SDK the snapshots are written with; snapshots of another SDK are not restored. */
export const WALLET_CACHE_SDK = "wallet-sdk-facade 5.0.0-beta.2";

/** Largest cache file read (a synced stagenet wallet is far below this). */
const MAX_CACHE_BYTES = 512 * 1024 * 1024;

/** A problem with the cache file. The message never contains file contents. */
export class WalletCacheError extends Error {
  constructor(
    readonly path: string,
    detail: string,
  ) {
    super(`wallet cache ${path}: ${detail}`);
    this.name = "WalletCacheError";
  }
}

/** The public identity a cache belongs to. */
export interface WalletCacheIdentity {
  readonly networkId: string;
  readonly coinPublicKey: string;
  readonly encryptionPublicKey: string;
  readonly unshieldedAddress: string;
  readonly dustAddress: string;
}

/** The serialized sub-wallet states. */
export interface WalletSnapshots {
  readonly shielded: string;
  readonly unshielded: string;
  readonly dust: string;
}

/** Result of {@link loadWalletCache}. */
export type WalletCacheLoad =
  | { readonly status: "absent" }
  | { readonly status: "stale"; readonly reason: string }
  | {
      readonly status: "restorable";
      readonly savedAt: string;
      readonly snapshots: WalletSnapshots;
    };

const IDENTITY_FIELDS = [
  "networkId",
  "coinPublicKey",
  "encryptionPublicKey",
  "unshieldedAddress",
  "dustAddress",
] as const;

const assertLocation = (path: string, allowInsideRepository: boolean): void => {
  if (allowInsideRepository) return;
  const repository = enclosingRepository(dirname(resolve(path)));
  if (repository !== undefined) {
    throw new WalletCacheError(
      path,
      `refusing a path inside the Git working tree ${repository}; use a directory outside every repository`,
    );
  }
};

/** Options for the cache functions. */
export interface WalletCacheOptions {
  /** Allow a path inside a Git working tree (tests only). Default false. */
  readonly allowInsideRepository?: boolean;
}

/** `path` and `other` name the same file (or `other` is missing and the paths are equal). */
export const sameFile = (path: string, other: string): boolean => {
  if (resolve(path) === resolve(other)) return true;
  try {
    const a = statSync(path);
    const b = statSync(other);
    return a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
};

/**
 * Read the envelope at `path`, or `undefined` when there is no file.
 *
 * @throws {WalletCacheError} When the file is unsafe (symlink, not regular, readable by
 * group or others, too large) or not a cache envelope.
 */
const readEnvelope = (path: string): Record<string, unknown> | undefined => {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new WalletCacheError(
      path,
      `cannot be read (${(error as NodeJS.ErrnoException).code ?? "error"})`,
    );
  }
  if (stats.isSymbolicLink()) throw new WalletCacheError(path, "is a symbolic link");
  if (!stats.isFile()) throw new WalletCacheError(path, "is not a regular file");
  if ((stats.mode & 0o077) !== 0) {
    throw new WalletCacheError(
      path,
      `mode ${(stats.mode & 0o777).toString(8)} lets group or others access it; run chmod 600`,
    );
  }
  if (stats.size > MAX_CACHE_BYTES) throw new WalletCacheError(path, "is too large");
  let parsed: unknown;
  try {
    // The parser's own message can quote the input; it is never shown.
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    parsed = undefined;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as Record<string, unknown>).kind !== WALLET_CACHE_KIND
  ) {
    throw new WalletCacheError(
      path,
      "exists but is not a wallet cache; refusing to use or overwrite it (choose another path)",
    );
  }
  return parsed as Record<string, unknown>;
};

const assertIdentity = (
  path: string,
  envelope: Record<string, unknown>,
  identity: WalletCacheIdentity,
): void => {
  for (const field of IDENTITY_FIELDS) {
    if (envelope[field] !== identity[field]) {
      throw new WalletCacheError(
        path,
        "belongs to a different wallet or network; refusing to use or overwrite it (choose another path)",
      );
    }
  }
};

/**
 * Load the cache for `identity`.
 *
 * @throws {WalletCacheError} When the file is unsafe, is not a cache, or belongs to
 * another wallet or network.
 */
export const loadWalletCache = (
  path: string,
  identity: WalletCacheIdentity,
  options: WalletCacheOptions = {},
): WalletCacheLoad => {
  assertLocation(path, options.allowInsideRepository === true);
  const envelope = readEnvelope(path);
  if (envelope === undefined) return { status: "absent" };
  assertIdentity(path, envelope, identity);
  if (envelope.version !== WALLET_CACHE_VERSION || envelope.sdk !== WALLET_CACHE_SDK) {
    return { status: "stale", reason: "it was written by another version; syncing from the start" };
  }
  const { shielded, unshielded, dust, savedAt } = envelope;
  if (
    typeof shielded !== "string" ||
    typeof unshielded !== "string" ||
    typeof dust !== "string" ||
    typeof savedAt !== "string"
  ) {
    return { status: "stale", reason: "it is incomplete; syncing from the start" };
  }
  return { status: "restorable", savedAt, snapshots: { shielded, unshielded, dust } };
};

/**
 * Save the snapshots for `identity`, replacing an earlier cache of the same wallet
 * atomically. Creates the parent directory with mode 0700 if needed.
 *
 * @throws {WalletCacheError} When the location is unsafe or an existing file is not a
 * cache of this wallet.
 */
export const saveWalletCache = (
  path: string,
  identity: WalletCacheIdentity,
  snapshots: WalletSnapshots,
  options: WalletCacheOptions & { readonly now?: Date } = {},
): void => {
  assertLocation(path, options.allowInsideRepository === true);
  const existing = readEnvelope(path);
  if (existing !== undefined) assertIdentity(path, existing, identity);
  const envelope = {
    kind: WALLET_CACHE_KIND,
    version: WALLET_CACHE_VERSION,
    sdk: WALLET_CACHE_SDK,
    ...Object.fromEntries(IDENTITY_FIELDS.map((field) => [field, identity[field]])),
    savedAt: (options.now ?? new Date()).toISOString(),
    shielded: snapshots.shielded,
    unshielded: snapshots.unshielded,
    dust: snapshots.dust,
  };
  const parent = dirname(resolve(path));
  const temporary = join(
    parent,
    `.${basename(path)}.tmp-${String(process.pid)}-${randomBytes(6).toString("hex")}`,
  );
  const previous = process.umask(0o077);
  try {
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
    const fd = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeSync(fd, `${JSON.stringify(envelope)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    if (error instanceof WalletCacheError) throw error;
    throw new WalletCacheError(
      path,
      `cannot be written (${(error as NodeJS.ErrnoException).code ?? "error"})`,
    );
  } finally {
    process.umask(previous);
  }
};
