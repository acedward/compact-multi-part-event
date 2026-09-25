/**
 * deploy-tools' wallet, offline parts: reading the mnemonic from a protected file (word count,
 * checksum, file mode; no word ever in an error), HD derivation (deterministic, three
 * distinct roles, network-specific addresses), a public identity that contains no
 * secret material, and the fee margin of the wallet facade's configuration (default 5
 * blocks, 0..100, checked before the mnemonic is read, passed to `WalletFacade.init`).
 * Syncing and transacting need a live network. The `funding` command's output is
 * tested in tests/deploy-tools-commands.test.ts.
 *
 * The mnemonic used here is the public all-"abandon" test phrase that SDK test kits
 * ship; it holds no funds and is never used against a network.
 */
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as ledger from "@midnightntwrk/ledger-v9";
import { WalletFacade } from "@midnightntwrk/wallet-sdk-facade";
import { mnemonicToSeedSync } from "@scure/bip39";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SecretFileError } from "../deploy-tools/secrets.js";
import {
  DEFAULT_FEE_BLOCKS_MARGIN,
  deriveWalletKeys,
  publicIdentity,
  readMnemonicFile,
  walletFacadeConfiguration,
  type WalletNetwork,
  WalletSession,
} from "../deploy-tools/wallet.js";

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
});

describe("fee margin (wallet facade configuration)", () => {
  const network: WalletNetwork = {
    networkId: "stagenet",
    indexerHttpUrl: "https://indexer.example/api/v4/graphql",
    indexerWsUrl: "wss://indexer.example/api/v4/graphql/ws",
    nodeUrl: "https://rpc.example",
    proofServerUrl: "http://127.0.0.1:6300",
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults to 5 blocks, the wallet SDK's own test value, and passes 0..100 through", () => {
    expect(DEFAULT_FEE_BLOCKS_MARGIN).toBe(5);
    expect(walletFacadeConfiguration(network).costParameters).toEqual({ feeBlocksMargin: 5 });
    for (const margin of [0, 1, 10, 100]) {
      expect(walletFacadeConfiguration(network, margin).costParameters.feeBlocksMargin).toBe(
        margin,
      );
    }
    const configuration = walletFacadeConfiguration(network);
    expect(configuration.relayURL.href).toBe("wss://rpc.example/");
    expect(configuration.provingServerUrl.href).toBe("http://127.0.0.1:6300/");
  });

  it("refuses a margin that is not an integer from 0 to 100", () => {
    for (const margin of [-1, 101, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => walletFacadeConfiguration(network, margin)).toThrow(RangeError);
    }
  });

  it("WalletSession.open hands the margin to WalletFacade.init, and checks it before reading the mnemonic", async () => {
    const seen: unknown[] = [];
    const stop = new Error("stop after init was called");
    vi.spyOn(WalletFacade, "init").mockImplementation((settings) => {
      seen.push(settings.configuration);
      return Promise.reject(stop);
    });
    const dustParameters = ledger.LedgerParameters.initialParameters().dust;
    const mnemonicFile = file(WORDS);
    for (const [feeBlocksMargin, expected] of [
      [undefined, 5],
      [0, 0],
      [42, 42],
    ] as const) {
      await expect(
        WalletSession.open({
          network,
          mnemonicFile,
          dustParameters,
          ...(feeBlocksMargin === undefined ? {} : { feeBlocksMargin }),
        }),
      ).rejects.toBe(stop);
      expect(seen.at(-1)).toMatchObject({ costParameters: { feeBlocksMargin: expected } });
    }
    expect(seen).toHaveLength(3);
    // An invalid margin fails first: the (missing) mnemonic file is never read.
    await expect(
      WalletSession.open({
        network,
        mnemonicFile: "/nonexistent/wallet.mnemonic",
        dustParameters,
        feeBlocksMargin: 101,
      }),
    ).rejects.toThrow(RangeError);
    expect(seen).toHaveLength(3);
  });
});
