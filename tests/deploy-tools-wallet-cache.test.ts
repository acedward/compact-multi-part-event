/**
 * Wallet-state cache file: protected like a secret file (mode 0600, regular file, no
 * symlink, outside every Git working tree), bound to one wallet's public identity and
 * network, written atomically, never overwriting a file that is not a cache of this
 * wallet, and never quoting file contents in an error. Restoring the snapshots into a
 * live wallet needs a network (P3); here the snapshots are opaque strings.
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  loadWalletCache,
  sameFile,
  saveWalletCache,
  WALLET_CACHE_KIND,
  WALLET_CACHE_SDK,
  WalletCacheError,
  type WalletCacheIdentity,
} from "../deploy-tools/wallet-cache.js";
import { deriveWalletKeys, publicIdentity } from "../deploy-tools/wallet.js";

const WORDS = `${"abandon ".repeat(23)}diesel`;
const identity: WalletCacheIdentity = publicIdentity(
  deriveWalletKeys(WORDS, "stagenet"),
  "stagenet",
);
const snapshots = {
  shielded: JSON.stringify({ state: "aa".repeat(64), offset: "1200" }),
  unshielded: JSON.stringify({ appliedId: "3" }),
  dust: JSON.stringify({ state: "bb".repeat(64), offset: "250000" }),
};

const directory = (): string => mkdtempSync(join(tmpdir(), "cmse-wallet-cache-"));

const errorOf = (run: () => unknown): string => {
  try {
    run();
    return "accepted";
  } catch (error) {
    expect(error).toBeInstanceOf(WalletCacheError);
    return (error as Error).message;
  }
};

describe("wallet cache", () => {
  it("is absent until saved, then round-trips for the same wallet", () => {
    const path = join(directory(), "nested", "stagenet.wallet-cache.json");
    expect(loadWalletCache(path, identity)).toEqual({ status: "absent" });
    saveWalletCache(path, identity, snapshots, { now: new Date("2026-09-23T12:00:00Z") });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
    expect(loadWalletCache(path, identity)).toEqual({
      status: "restorable",
      savedAt: "2026-09-23T12:00:00.000Z",
      snapshots,
    });
    const envelope = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(envelope.kind).toBe(WALLET_CACHE_KIND);
    expect(envelope.sdk).toBe(WALLET_CACHE_SDK);
    expect(envelope.unshieldedAddress).toBe(identity.unshieldedAddress);
    expect(readFileSync(path, "utf8")).not.toContain("abandon");
  });

  it("replaces an earlier cache of the same wallet atomically, leaving no temporary file", () => {
    const dir = directory();
    const path = join(dir, "cache.json");
    saveWalletCache(path, identity, snapshots);
    saveWalletCache(path, identity, { ...snapshots, dust: "{}" });
    const loaded = loadWalletCache(path, identity);
    expect(loaded.status === "restorable" && loaded.snapshots.dust).toBe("{}");
    expect(readdirSync(dir)).toEqual(["cache.json"]);
  });

  it("refuses the cache of another wallet or network, and never overwrites it", () => {
    const path = join(directory(), "cache.json");
    saveWalletCache(path, identity, snapshots);
    const before = readFileSync(path, "utf8");
    const other = publicIdentity(
      deriveWalletKeys(`${"zoo ".repeat(23)}wrong`, "stagenet"),
      "stagenet",
    );
    expect(errorOf(() => loadWalletCache(path, other))).toContain("belongs to a different wallet");
    expect(errorOf(() => saveWalletCache(path, other, snapshots))).toContain(
      "belongs to a different wallet",
    );
    const preview = { ...identity, networkId: "preview" };
    expect(errorOf(() => loadWalletCache(path, preview))).toContain("different wallet or network");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("refuses a file that is not a cache, never overwrites it and never quotes it", () => {
    const path = join(directory(), "wallet.mnemonic");
    writeFileSync(path, `${WORDS}\n`, { mode: 0o600 });
    const load = errorOf(() => loadWalletCache(path, identity));
    const save = errorOf(() => saveWalletCache(path, identity, snapshots));
    for (const message of [load, save]) {
      expect(message).toContain("is not a wallet cache; refusing to use or overwrite it");
      expect(message).not.toContain("abandon");
      expect(message).not.toContain("diesel");
    }
    expect(readFileSync(path, "utf8")).toBe(`${WORDS}\n`);
    expect(sameFile(path, join(path, "..", "wallet.mnemonic"))).toBe(true);
    expect(sameFile(path, join(path, "..", "other"))).toBe(false);
  });

  it("refuses loose modes, symlinks, non-regular files and Git working trees", () => {
    const dir = directory();
    const path = join(dir, "cache.json");
    saveWalletCache(path, identity, snapshots);
    chmodSync(path, 0o644);
    expect(errorOf(() => loadWalletCache(path, identity))).toContain("run chmod 600");
    chmodSync(path, 0o600);
    const link = join(dir, "link.json");
    symlinkSync(path, link);
    expect(errorOf(() => loadWalletCache(link, identity))).toContain("symbolic link");
    const folder = join(dir, "folder");
    mkdirSync(folder);
    expect(errorOf(() => loadWalletCache(folder, identity))).toContain("not a regular file");
    const repository = directory();
    mkdirSync(join(repository, ".git"));
    const inside = join(repository, "state", "cache.json");
    expect(errorOf(() => saveWalletCache(inside, identity, snapshots))).toContain(
      "inside the Git working tree",
    );
    expect(errorOf(() => loadWalletCache(inside, identity))).toContain(
      "inside the Git working tree",
    );
  });

  it("treats a cache from another SDK version as stale (full sync, then replaced)", () => {
    const path = join(directory(), "cache.json");
    saveWalletCache(path, identity, snapshots);
    const envelope = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...envelope, sdk: "wallet-sdk-facade 5.0.0-beta.3" }), {
      mode: 0o600,
    });
    expect(loadWalletCache(path, identity)).toMatchObject({ status: "stale" });
    saveWalletCache(path, identity, snapshots);
    expect(loadWalletCache(path, identity).status).toBe("restorable");
  });
});
