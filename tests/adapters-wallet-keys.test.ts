/**
 * Wallet adapter, offline parts: reading the mnemonic from a protected file (word count,
 * checksum, file mode; no word ever in an error), HD derivation (deterministic, three
 * distinct roles, network-specific addresses), and a public identity that contains no
 * secret material. Syncing and transacting need a live network (P3).
 *
 * The mnemonic used here is the public all-"abandon" test phrase that SDK test kits
 * ship; it holds no funds and is never used against a network.
 */
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mnemonicToSeedSync } from "@scure/bip39";
import { describe, expect, it } from "vitest";

import { SecretFileError } from "../src/adapters/secrets.js";
import { deriveWalletKeys, publicIdentity, readMnemonicFile } from "../src/adapters/wallet.js";
import { runFunding } from "../src/cli/commands.js";

const WORDS = `${"abandon ".repeat(23)}diesel`;

const file = (content: string, mode = 0o600): string => {
  const dir = mkdtempSync(join(tmpdir(), "cmse-wallet-"));
  const path = join(dir, "wallet.mnemonic");
  writeFileSync(path, content, { mode });
  chmodSync(path, mode);
  return path;
};

const errorOf = (run: () => unknown): string => {
  try {
    run();
    return "accepted";
  } catch (error) {
    expect(error).toBeInstanceOf(SecretFileError);
    return (error as Error).message;
  }
};

describe("mnemonic file", () => {
  it("accepts a valid phrase with any whitespace and case", () => {
    expect(readMnemonicFile(file(`  ${WORDS.toUpperCase().replaceAll(" ", "\n\t ")}\n`))).toBe(
      WORDS,
    );
  });

  it("refuses wrong word counts, bad checksums, unknown words and loose modes, never echoing words", () => {
    const short = errorOf(() => readMnemonicFile(file("abandon abandon abandon")));
    expect(short).toContain("holds 3 words");
    const checksum = errorOf(() => readMnemonicFile(file(`${"abandon ".repeat(23)}abandon`)));
    expect(checksum).toContain("not a valid English BIP-39 mnemonic");
    const unknown = errorOf(() => readMnemonicFile(file(`${"abandon ".repeat(23)}zzzzzz`)));
    expect(unknown).not.toContain("zzzzzz");
    const loose = errorOf(() => readMnemonicFile(file(WORDS, 0o640)));
    expect(loose).toContain("chmod 600");
    for (const text of [short, checksum, unknown, loose]) expect(text).not.toContain("abandon");
  });
});

describe("key derivation and public identity", () => {
  const keys = deriveWalletKeys(WORDS, "stagenet");
  const identity = publicIdentity(keys, "stagenet");

  it("derives bech32m stagenet addresses and hex public keys", () => {
    expect(identity.unshieldedAddress).toMatch(/^mn_addr_stagenet1[0-9a-z]+$/);
    expect(identity.shieldedAddress).toMatch(/^mn_shield-addr_stagenet1[0-9a-z]+$/);
    expect(identity.dustAddress).toMatch(/^mn_dust_stagenet1[0-9a-z]+$/);
    expect(identity.coinPublicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(identity.encryptionPublicKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic and network-specific", () => {
    const again = publicIdentity(deriveWalletKeys(WORDS, "stagenet"), "stagenet");
    expect(again).toEqual(identity);
    const preview = publicIdentity(deriveWalletKeys(WORDS, "preview"), "preview");
    expect(preview.unshieldedAddress).toMatch(/^mn_addr_preview1/);
    expect(preview.coinPublicKey).toBe(identity.coinPublicKey);
  });

  it("uses three different keys for the three roles", () => {
    const unshieldedPublic = Buffer.from(
      keys.unshieldedKeystore.getPublicKey().value,
      "hex",
    ).toString("hex");
    expect(
      new Set([identity.coinPublicKey, identity.encryptionPublicKey, unshieldedPublic]).size,
    ).toBe(3);
  });

  it("contains no secret material: not the seed, not any role secret, not the phrase", () => {
    const text = JSON.stringify(identity);
    const seedHex = Buffer.from(mnemonicToSeedSync(WORDS)).toString("hex");
    expect(text).not.toContain(seedHex.slice(0, 32));
    expect(text).not.toContain(keys.unshieldedKeystore.getSecretKey().toString("hex").slice(0, 32));
    expect(text).not.toContain("abandon");
  });

  it("funding prints only the public identity and balances", async () => {
    const lines: string[] = [];
    const report = await runFunding(
      {
        identity,
        balances: () =>
          Promise.resolve({
            night: 5_000_000_000n,
            dust: 12n,
            shielded: {},
            nightUtxos: [
              {
                value: 5_000_000_000n,
                intentHash: "ab".repeat(32),
                outputNo: 0,
                ctime: "2026-09-23T00:00:00.000Z",
                registeredForDustGeneration: false,
              },
            ],
          }),
        registerForDust: (mode) => Promise.resolve({ mode, unregistered: 1, fee: 7n }),
      },
      { registerDust: "estimate" },
      (line) => lines.push(line),
    );
    const output = lines.join("\n");
    expect(output).toContain(identity.unshieldedAddress);
    expect(output).toContain("NIGHT              5000000000 STAR (1 UTxO)");
    expect(output).toContain("DUST registration  estimate: 1 unregistered UTxO, fee 7 SPECK");
    expect(output).not.toContain("abandon");
    expect(output).not.toContain(keys.unshieldedKeystore.getSecretKey().toString("hex"));
    expect(report.dustRegistration?.fee).toBe(7n);
  });
});
