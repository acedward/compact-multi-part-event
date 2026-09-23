/**
 * Wallet adapter: a Midnight wallet (wallet-sdk-facade 5.0.0-beta.2, built from its
 * sub-packages) opened from a BIP-39 mnemonic stored in a protected file referenced by
 * path.
 *
 * - The mnemonic is read with the protected-file rules of `./secrets` (regular file,
 *   mode 0600 or stricter, never a symlink), validated, turned into the BIP-39 seed
 *   (empty passphrase, as Lace does) and derived along the Midnight HD path (account 0,
 *   index 0; roles Zswap, NightExternal, Dust). Nothing derived from it is logged or
 *   returned for printing; only public addresses and keys are.
 * - Balancing waits (bounded) until the wallet's DUST covers the fee, then balances the
 *   proven transaction, signs the balancing part and finalizes it. The wallet proves
 *   its own fee inputs through its proving service (the local proof server).
 * - DUST registration registers unregistered NIGHT UTxOs; the facade already signs the
 *   registration recipe, so it is finalized without a second signature.
 *
 * The wallet reads the chain through the indexer and submits through the node relay.
 * It keeps its state in memory only; nothing is written to disk.
 *
 * @module
 */
import * as ledger from "@midnightntwrk/ledger-v9";
import { NoOpTransactionHistoryStorage } from "@midnightntwrk/wallet-sdk-abstractions";
import {
  DustAddress,
  MidnightBech32m,
  ShieldedAddress,
  ShieldedCoinPublicKey,
  ShieldedEncryptionPublicKey,
} from "@midnightntwrk/wallet-sdk-address-format";
import { DustWallet } from "@midnightntwrk/wallet-sdk-dust-wallet";
import { type FacadeState, WalletFacade } from "@midnightntwrk/wallet-sdk-facade";
import { HDWallet, Roles } from "@midnightntwrk/wallet-sdk-hd";
import { ShieldedWallet } from "@midnightntwrk/wallet-sdk-shielded";
import {
  createKeystore,
  PublicKey,
  UnshieldedWallet,
  type UnshieldedKeystore,
} from "@midnightntwrk/wallet-sdk-unshielded-wallet";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist as english } from "@scure/bip39/wordlists/english.js";
import * as Rx from "rxjs";

import type { PublicationBalancer, PublicationSubmitter } from "../transaction/finalize.js";
import { readProtectedFile, SecretFileError } from "./secrets.js";

/** Endpoints a wallet session talks to. */
export interface WalletNetwork {
  /** Ledger network id, e.g. `stagenet`. */
  readonly networkId: string;
  /** Indexer GraphQL HTTP endpoint. */
  readonly indexerHttpUrl: string;
  /** Indexer GraphQL WebSocket endpoint. */
  readonly indexerWsUrl: string;
  /** Node RPC endpoint (http(s)); the submission relay is the same host over ws(s). */
  readonly nodeUrl: string;
  /** Proof server the wallet proves its fee inputs with (run it locally). */
  readonly proofServerUrl: string;
}

/**
 * Read and validate a BIP-39 mnemonic from a protected file. Error messages never
 * include any word of the file.
 */
export const readMnemonicFile = (path: string): string => {
  const phrase = readProtectedFile(path).trim().split(/\s+/u).join(" ").toLowerCase();
  const words = phrase.split(" ").length;
  if (![12, 15, 18, 21, 24].includes(words)) {
    throw new SecretFileError(path, `holds ${String(words)} words; a BIP-39 mnemonic has 12-24`);
  }
  if (!validateMnemonic(phrase, english)) {
    throw new SecretFileError(path, "is not a valid English BIP-39 mnemonic (checksum or word)");
  }
  return phrase;
};

/** Secret key material of a wallet (in memory only; call `clear` when done). */
export interface WalletKeys {
  readonly shieldedSecretKeys: ledger.ZswapSecretKeys;
  readonly dustSecretKey: ledger.DustSecretKey;
  readonly unshieldedKeystore: UnshieldedKeystore;
  clear(): void;
}

/**
 * Derive wallet keys from a mnemonic: BIP-39 seed (empty passphrase), then the Midnight
 * HD tree at account 0, index 0 for the Zswap, NightExternal and Dust roles.
 */
export const deriveWalletKeys = (mnemonic: string, networkId: string): WalletKeys => {
  const seed = mnemonicToSeedSync(mnemonic);
  try {
    const hd = HDWallet.fromSeed(seed);
    if (hd.type !== "seedOk") throw new Error("wallet seed rejected by the HD derivation");
    try {
      const derived = hd.hdWallet
        .selectAccount(0)
        .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust] as const)
        .deriveKeysAt(0);
      if (derived.type !== "keysDerived") throw new Error("wallet key derivation out of bounds");
      const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(derived.keys[Roles.Zswap]);
      const dustSecretKey = ledger.DustSecretKey.fromSeed(derived.keys[Roles.Dust]);
      const unshieldedKeystore = createKeystore(
        { kind: "schnorr", secret: derived.keys[Roles.NightExternal] },
        networkId,
      );
      for (const key of Object.values(derived.keys)) key.fill(0);
      return {
        shieldedSecretKeys,
        dustSecretKey,
        unshieldedKeystore,
        clear: () => {
          shieldedSecretKeys.clear();
          dustSecretKey.clear();
        },
      };
    } finally {
      hd.hdWallet.clear();
    }
  } finally {
    seed.fill(0);
  }
};

/** Public identity of a wallet: safe to print and record. */
export interface PublicWalletIdentity {
  readonly networkId: string;
  /** Unshielded address (bech32m), where tNight from a faucet is sent. */
  readonly unshieldedAddress: string;
  /** Shielded address (bech32m). */
  readonly shieldedAddress: string;
  /** DUST address (bech32m). */
  readonly dustAddress: string;
  /** Zswap coin public key, hex (the circuits' `ownPublicKey`). */
  readonly coinPublicKey: string;
  /** Zswap encryption public key, hex. */
  readonly encryptionPublicKey: string;
}

/** Public addresses and keys of derived wallet keys. */
export const publicIdentity = (keys: WalletKeys, networkId: string): PublicWalletIdentity => {
  const coinPublicKey = keys.shieldedSecretKeys.coinPublicKey;
  const encryptionPublicKey = keys.shieldedSecretKeys.encryptionPublicKey;
  const shielded = new ShieldedAddress(
    new ShieldedCoinPublicKey(Buffer.from(coinPublicKey, "hex")),
    new ShieldedEncryptionPublicKey(Buffer.from(encryptionPublicKey, "hex")),
  );
  return {
    networkId,
    unshieldedAddress: keys.unshieldedKeystore.getBech32Address().asString(),
    shieldedAddress: MidnightBech32m.encode(networkId, shielded).asString(),
    dustAddress: DustAddress.encodePublicKey(networkId, keys.dustSecretKey.publicKey),
    coinPublicKey,
    encryptionPublicKey,
  };
};

/** One NIGHT UTxO (public data). */
export interface NightUtxo {
  readonly value: bigint;
  readonly intentHash: string;
  readonly outputNo: number;
  readonly ctime: string;
  readonly registeredForDustGeneration: boolean;
}

/** Wallet balances after a sync (public data). */
export interface WalletBalances {
  /** Unshielded NIGHT, in STAR (10^-6 NIGHT). */
  readonly night: bigint;
  /** Spendable DUST now, in SPECK (10^-15 DUST). */
  readonly dust: bigint;
  readonly nightUtxos: readonly NightUtxo[];
  /** Shielded balances by raw token type. */
  readonly shielded: Readonly<Record<string, bigint>>;
}

/** Outcome of {@link WalletSession.registerForDust}. */
export interface DustRegistrationReport {
  readonly mode: "estimate" | "register";
  /** NIGHT UTxOs that were not yet registered. */
  readonly unregistered: number;
  /** Registration fee estimate, SPECK. */
  readonly fee?: bigint;
  /** Submitted registration transaction identifier (register mode). */
  readonly transactionId?: string;
  /** DUST after the registration was observed (register mode). */
  readonly dustAfter?: bigint;
  readonly note?: string;
}

/** Options for {@link WalletSession.open}. */
export interface WalletSessionOptions {
  readonly network: WalletNetwork;
  /** Path of the protected mnemonic file (read here; never printed). */
  readonly mnemonicFile: string;
  /** DUST parameters of the network (from its current ledger parameters). */
  readonly dustParameters: ledger.DustParameters;
  /** Fee headroom in blocks for the wallet's fee estimate (default 100). */
  readonly feeBlocksMargin?: number;
  /** Bound for a sync (default 600000 ms). */
  readonly syncTimeoutMs?: number;
  /** Bound for waiting until DUST covers a fee (default 600000 ms). */
  readonly feeWaitMs?: number;
  /** Public progress messages (never secret). */
  readonly log?: (message: string) => void;
}

const wsUrl = (httpUrl: string): URL => {
  const url = new URL(httpUrl);
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  return url;
};

const errorText = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

/** A running wallet. Close it when done; never run two sessions on one mnemonic. */
export class WalletSession {
  readonly identity: PublicWalletIdentity;
  readonly #facade: WalletFacade;
  readonly #keys: WalletKeys;
  readonly #syncTimeoutMs: number;
  readonly #feeWaitMs: number;
  readonly #log: (message: string) => void;

  private constructor(
    facade: WalletFacade,
    keys: WalletKeys,
    identity: PublicWalletIdentity,
    options: WalletSessionOptions,
  ) {
    this.#facade = facade;
    this.#keys = keys;
    this.identity = identity;
    this.#syncTimeoutMs = options.syncTimeoutMs ?? 600_000;
    this.#feeWaitMs = options.feeWaitMs ?? 600_000;
    this.#log = options.log ?? (() => undefined);
  }

  /** Read the mnemonic file, derive keys, build and start the wallet. */
  static async open(options: WalletSessionOptions): Promise<WalletSession> {
    const keys = deriveWalletKeys(
      readMnemonicFile(options.mnemonicFile),
      options.network.networkId,
    );
    try {
      const identity = publicIdentity(keys, options.network.networkId);
      const configuration = {
        networkId: options.network.networkId,
        indexerClientConnection: {
          indexerHttpUrl: options.network.indexerHttpUrl,
          indexerWsUrl: options.network.indexerWsUrl,
        },
        provingServerUrl: new URL(options.network.proofServerUrl),
        relayURL: wsUrl(options.network.nodeUrl),
        costParameters: { feeBlocksMargin: options.feeBlocksMargin ?? 100 },
        txHistoryStorage: new NoOpTransactionHistoryStorage(),
      };
      const facade = await WalletFacade.init({
        configuration,
        shielded: (config) => ShieldedWallet(config).startWithSecretKeys(keys.shieldedSecretKeys),
        unshielded: (config) =>
          UnshieldedWallet(config).startWithPublicKey(
            PublicKey.fromKeyStore(keys.unshieldedKeystore),
          ),
        dust: (config) =>
          DustWallet(config).startWithSecretKey(keys.dustSecretKey, options.dustParameters),
      });
      await facade.start(keys.shieldedSecretKeys, keys.dustSecretKey);
      return new WalletSession(facade, keys, identity, options);
    } catch (error) {
      keys.clear();
      throw error;
    }
  }

  /** Wait for a stable synced state (sampled every 5 s; the flag can flip early). */
  async synced(): Promise<FacadeState> {
    return await Rx.firstValueFrom(
      this.#facade.state().pipe(
        Rx.throttleTime(5_000, undefined, { leading: true, trailing: true }),
        Rx.filter((state) => state.isSynced),
        Rx.timeout({
          first: this.#syncTimeoutMs,
          with: () => Rx.throwError(() => new Error("wallet did not sync in time")),
        }),
      ),
    );
  }

  /** Balances after a sync. */
  async balances(): Promise<WalletBalances> {
    const state = await this.synced();
    const night = ledger.nativeToken().raw;
    const nightUtxos = state.unshielded.availableCoins
      .filter((coin) => coin.utxo.type === night)
      .map((coin) => ({
        value: coin.utxo.value,
        intentHash: coin.utxo.intentHash,
        outputNo: coin.utxo.outputNo,
        ctime: coin.meta.ctime.toISOString(),
        registeredForDustGeneration: coin.meta.registeredForDustGeneration,
      }));
    return {
      night: state.unshielded.balances[night] ?? 0n,
      dust: state.dust.balance(new Date()),
      nightUtxos,
      shielded: { ...state.shielded.balances },
    };
  }

  /**
   * Register every unregistered NIGHT UTxO for DUST generation (`register`), or only
   * report the fee estimate (`estimate`). The registration pays its fee from DUST the
   * UTxOs have already generated, so it waits (bounded) for that first.
   */
  async registerForDust(
    mode: "estimate" | "register",
    options: { readonly waitMs?: number } = {},
  ): Promise<DustRegistrationReport> {
    const state = await this.synced();
    const night = ledger.nativeToken().raw;
    const unregistered = state.unshielded.availableCoins.filter(
      (coin) => coin.utxo.type === night && !coin.meta.registeredForDustGeneration,
    );
    if (unregistered.length === 0) {
      return { mode, unregistered: 0, note: "no unregistered NIGHT UTxO; nothing to do" };
    }
    const estimate = await this.#facade.estimateRegistration(unregistered);
    if (mode === "estimate") return { mode, unregistered: unregistered.length, fee: estimate.fee };
    const waitMs = options.waitMs ?? 600_000;
    await this.#facade.waitForGeneratedDust(unregistered, estimate.fee, { timeoutMs: waitMs });
    const recipe = await this.#facade.registerNightUtxosForDustGeneration(
      unregistered,
      this.#keys.unshieldedKeystore.getPublicKey(),
      (data) => this.#keys.unshieldedKeystore.signDataAsync(data),
    );
    // The facade already signed this recipe; signing again makes the node reject it.
    const finalized = await this.#facade.finalizeRecipe(recipe);
    const transactionId = await this.#facade.submitTransaction(finalized);
    this.#log(`DUST registration submitted: ${transactionId}`);
    const deadline = Date.now() + waitMs;
    for (;;) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 6_000));
      const next = await this.synced();
      const dust = next.dust.balance(new Date());
      const registered = next.unshielded.availableCoins.some(
        (coin) => coin.utxo.type === night && coin.meta.registeredForDustGeneration,
      );
      if (registered && dust > 0n) {
        return {
          mode,
          unregistered: unregistered.length,
          fee: estimate.fee,
          transactionId,
          dustAfter: dust,
        };
      }
      if (Date.now() > deadline) {
        return {
          mode,
          unregistered: unregistered.length,
          fee: estimate.fee,
          transactionId,
          note: "submitted, but no registered UTxO with DUST was observed in time",
        };
      }
    }
  }

  async #waitForFeeBudget(
    tx: ledger.Transaction<ledger.SignatureEnabled, ledger.Proof, ledger.PreBinding>,
    ttl: Date,
  ): Promise<void> {
    const deadline = Date.now() + this.#feeWaitMs;
    let announced = false;
    for (;;) {
      try {
        await this.#facade.estimateTransactionFee(tx, this.#keys.dustSecretKey, { ttl });
        return;
      } catch (error) {
        if (!/insufficient funds|could not balance dust/i.test(errorText(error))) throw error;
      }
      if (!announced) {
        this.#log("waiting for the wallet to hold enough DUST for the fee");
        announced = true;
      }
      if (Date.now() >= deadline) throw new Error("timed out waiting for enough DUST for the fee");
      await new Promise((resolveWait) => setTimeout(resolveWait, 5_000));
    }
  }

  /** A balancer for the composer and for deployments: pays fees, signs, binds. */
  balancer(): PublicationBalancer {
    return {
      balanceTx: async (tx, ttl) => {
        const transactionTtl = ttl ?? new Date(Date.now() + 20 * 60 * 1000);
        await this.#waitForFeeBudget(tx, transactionTtl);
        const recipe = await this.#facade.balanceUnboundTransaction(
          tx,
          {
            shieldedSecretKeys: this.#keys.shieldedSecretKeys,
            dustSecretKey: this.#keys.dustSecretKey,
          },
          { ttl: transactionTtl },
        );
        const signed = await this.#facade.signRecipe(recipe, (data) =>
          this.#keys.unshieldedKeystore.signDataAsync(data),
        );
        return await this.#facade.finalizeRecipe(signed);
      },
    };
  }

  /** A submitter that sends finalized transactions through the node relay. */
  submitter(): PublicationSubmitter {
    return { submitTx: (tx) => this.#facade.submitTransaction(tx) };
  }

  /** The wallet's Zswap coin public key, hex (the circuits' Zswap context). */
  coinPublicKey(): string {
    return this.identity.coinPublicKey;
  }

  /** Stop syncing and clear key material. */
  async close(): Promise<void> {
    try {
      await this.#facade.stop();
    } finally {
      this.#keys.clear();
    }
  }
}
