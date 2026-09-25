/**
 * deploy-tools: deploy and exercise this repository's examples on a live network.
 * Not part of the library; run from a clone as `npm run deploy-tools -- <command> …`.
 *
 * Configuration comes from flags or `CMSE_*` environment variables (`--help` lists
 * them). Secrets are only ever passed as file PATHS; no command prints one.
 *
 * @module
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  type IndexedTransaction,
  IndexerClient,
  indexerStateSource,
  ledgerParametersFromHex,
  PublicDataError,
  waitForTransaction,
} from "../src/indexer/index.js";
import {
  consoleIo,
  exitAfterFlush,
  hex32,
  invokedDirectly,
  type Io,
  jsonSafe,
  Options,
  parseArgs,
  UsageError,
} from "../src/cli/options.js";
import {
  DEFAULT_MAX_PARTS,
  DEFAULT_MAX_TTL_SECONDS,
  DEFAULT_TTL_SECONDS,
  MAX_PARTS_CEILING,
  PackageCheckError,
  type PublicationBalancer,
  type PublicationProver,
  type PublicationSubmitter,
} from "../src/publisher/index.js";
import { hexToBytes } from "../src/reader/bytes.js";
import {
  type ChainServices,
  CommandFailure,
  type FundingWallet,
  type IncludedTransaction,
  runDeploy,
  runFunding,
  runPin,
  runPublish,
} from "./commands.js";
import { ENV_FOR_FLAG, type Endpoints, resolveEndpoints, resolveProofServer } from "./config.js";
import {
  committedVerifierKeys,
  type ExampleProfile,
  loadGeneratedModule,
  profileOf,
} from "./contracts.js";
import { proofServerProver, proverFromEndpoint } from "./prover.js";
import { SecretFileError } from "./secrets.js";
import {
  DEFAULT_FEE_BLOCKS_MARGIN,
  MAX_FEE_BLOCKS_MARGIN,
  WalletSession,
  type WalletSessionOptions,
} from "./wallet.js";
import { WalletCacheError } from "./wallet-cache.js";
import { WalletNotSyncedError } from "./wallet-sync.js";
import { checkArtifactHashes, zkConfigForContract } from "./zk-config.js";

export const USAGE = `deploy-tools — deploy and exercise this repository's examples on a live network
(not part of the library; run from a clone after npm ci, npm run compile and, for
publish and pin, npm run compile:zk)

  npm run deploy-tools -- funding [--register-dust estimate|register]
  npm run deploy-tools -- deploy  --example emitter|notice-board --out <new record.json>
                                  --emitter-secret-file <new path> --maintenance-key-file <new path>
                                  [--reuse-secret] [--reuse-maintenance-key]
  npm run deploy-tools -- publish --example emitter|notice-board --contract <address>
                                  (--message <text> | --message-hex <hex> | --message-file <path>)...
                                  --emitter-secret-file <path> --out <new record.json>
                                  [--max-parts <n>] [--max-block-fraction <f>] [--dry-run]
  npm run deploy-tools -- pin     --example notice-board --contract <address> --digest <64 hex>
                                  --emitter-secret-file <path> --out <new record.json>

publish: every message is one package (256-byte parts, the last zero-padded) in an intent
of its own; several messages go into ONE transaction, one intent each. --message is text
in the example's format (emitter: UTF-8; notice-board: 4-byte big-endian length, then
UTF-8); --message-hex and --message-file are the payload bytes. The record (finalized
public bytes, identifiers, each package's segment and intent hash) is written before the
one submission; after inclusion every package is verified from the raw bytes.
Default part cap ${String(DEFAULT_MAX_PARTS)} (--max-parts up to ${String(MAX_PARTS_CEILING)}; the block limits decide the real maximum).

Network (flag or environment variable; defaults are stagenet's public endpoints):
  --network CMSE_NETWORK (stagenet)   --indexer CMSE_INDEXER_URL   --indexer-ws CMSE_INDEXER_WS_URL
  --node CMSE_NODE_URL                --proof-server CMSE_PROOF_SERVER_URL (loopback only, unless
  --allow-remote-prover)              --proof-concurrency CMSE_PROOF_CONCURRENCY (4)
  --zk-dir CMSE_ZK_DIR (build/zk/<example>, from npm run compile:zk)
  --ttl-seconds (${String(DEFAULT_TTL_SECONDS)}, at most ${String(DEFAULT_MAX_TTL_SECONDS)})   --proof-timeout-seconds (900)
Secrets (paths only; files are mode 0600, outside every Git working tree):
  --wallet-mnemonic-file CMSE_WALLET_MNEMONIC_FILE   --emitter-secret-file CMSE_EMITTER_SECRET_FILE
  --maintenance-key-file CMSE_MAINTENANCE_KEY_FILE
Wallet sync (every command waits for a COMPLETE sync of the shielded, unshielded and DUST
wallets; a first sync downloads every ledger event and can take long):
  --sync-timeout-minutes CMSE_SYNC_TIMEOUT_MINUTES (60)   progress is printed every 30 s;
  --wallet-cache-file CMSE_WALLET_CACHE_FILE (optional; mode 0600, outside every Git working tree)
      saves the synced wallet state and restores it on the next run. It holds private wallet
      data (no keys): protect it like a secret file.
If the sync does not complete in time the command prints "not synced" and exits 1; balances
are never printed from an incomplete sync.
Wallet fees: --fee-blocks-margin CMSE_FEE_BLOCKS_MARGIN (5; an integer from 0 to 100)
  the wallet declares, and the ledger consumes, the fee the transaction would need after
  the fee prices rose for this many blocks (up to about 4.6% per block on stagenet: 5
  blocks ≈ ×1.25 the required fee, 100 blocks ≈ ×89). Too small a margin can get a
  transaction refused when prices rise before it is included.
Output: --json prints the public record as JSON on stdout (progress goes to stderr).

Exit status: 0 success; 1 a check or transaction failed (or the wallet is not synced);
2 usage or input error; 3 not found.
`;

const FLAGS = {
  valued: new Set([
    "network",
    "indexer",
    "indexer-ws",
    "node",
    "proof-server",
    "proof-concurrency",
    "wallet-mnemonic-file",
    "wallet-cache-file",
    "sync-timeout-minutes",
    "fee-blocks-margin",
    "emitter-secret-file",
    "maintenance-key-file",
    "zk-dir",
    "register-dust",
    "example",
    "out",
    "contract",
    "message",
    "message-hex",
    "message-file",
    "digest",
    "max-parts",
    "max-block-fraction",
    "ttl-seconds",
    "proof-timeout-seconds",
  ]),
  switches: new Set([
    "json",
    "help",
    "allow-remote-prover",
    "reuse-secret",
    "reuse-maintenance-key",
    "dry-run",
  ]),
  repeatable: new Set(["message", "message-hex", "message-file"]),
};

/** What deploy-tools needs from a wallet ({@link WalletSession} provides it). */
export interface ToolWallet extends FundingWallet {
  /** Resolves after a complete sync; throws `WalletNotSyncedError` otherwise. */
  synced(): Promise<unknown>;
  balancer(): PublicationBalancer;
  submitter(): PublicationSubmitter;
  coinPublicKey(): string;
  close(): Promise<void>;
}

/** Replaceable services of {@link main} (tests use stand-ins). */
export interface ToolDependencies {
  /** Opens the wallet (default {@link WalletSession.open}). */
  readonly openWallet?: (options: WalletSessionOptions) => Promise<ToolWallet>;
  /** Proves transactions (default: the proof server, over the example's full key build). */
  readonly prover?: PublicationProver;
  /** Require proven, bound final bytes (default true; offline tests set false). */
  readonly requireProofs?: boolean;
}

/** Open the wallet with the command line's sync, cache and fee-margin settings. */
const openWallet = async (
  options: Options,
  endpoints: Endpoints,
  proofServerUrl: string,
  dustParameters: WalletSessionOptions["dustParameters"],
  log: (line: string) => void,
  dependencies: ToolDependencies,
): Promise<ToolWallet> => {
  const stateCacheFile = options.string("wallet-cache-file");
  const open = dependencies.openWallet ?? ((settings) => WalletSession.open(settings));
  return await open({
    network: {
      networkId: endpoints.network,
      indexerHttpUrl: endpoints.indexer,
      indexerWsUrl: endpoints.indexerWs,
      nodeUrl: endpoints.node,
      proofServerUrl,
    },
    mnemonicFile: options.required("wallet-mnemonic-file", "the wallet mnemonic file"),
    dustParameters,
    syncTimeoutMs: options.integer("sync-timeout-minutes", 60, 24 * 60) * 60_000,
    feeBlocksMargin: options.integer(
      "fee-blocks-margin",
      DEFAULT_FEE_BLOCKS_MARGIN,
      MAX_FEE_BLOCKS_MARGIN,
      0,
    ),
    ...(stateCacheFile === undefined ? {} : { stateCacheFile }),
    log,
  });
};

const toIncluded = (tx: IndexedTransaction): IncludedTransaction => ({
  hash: tx.hash,
  rawHex: tx.rawHex,
  status: tx.status ?? "",
  identifiers: tx.identifiers,
  blockHeight: tx.block.height,
  blockHash: tx.block.hash,
});

/** The refusing endpoint used where a transaction has no contract calls (deployments). */
const noCallsEndpoint = {
  check: () => Promise.reject(new Error("this transaction has no contract calls to prove")),
  prove: () => Promise.reject(new Error("this transaction has no contract calls to prove")),
  lookupKey: () => Promise.resolve(undefined),
};

/** One message payload per `--message`, `--message-hex` or `--message-file`, in order. */
const messagesOf = (options: Options, profile: ExampleProfile): Uint8Array[] =>
  options.parsed.sequence.map(({ name, value }) => {
    if (name === "message") return profile.encodeText(value);
    if (name === "message-hex") {
      const clean = value.replace(/^0x/iu, "").toLowerCase();
      if (!/^([0-9a-f]{2})+$/u.test(clean)) {
        throw new UsageError("--message-hex must be non-empty hex");
      }
      return hexToBytes(clean);
    }
    if (!existsSync(value)) throw new UsageError(`--message-file ${value} does not exist`);
    return new Uint8Array(readFileSync(value));
  });

interface OpenedServices {
  readonly services: ChainServices;
  close(): Promise<void>;
}

const openChainServices = async (
  options: Options,
  profile: ExampleProfile,
  proves: boolean,
  log: (line: string) => void,
  dependencies: ToolDependencies,
): Promise<OpenedServices> => {
  const endpoints = resolveEndpoints(options);
  const proofServer = resolveProofServer(options);
  const indexer = new IndexerClient({ url: endpoints.indexer });
  let prover = dependencies.prover ?? proverFromEndpoint(noCallsEndpoint);
  if (proves && dependencies.prover === undefined) {
    const zkDir = options.string("zk-dir") ?? profile.zkDir;
    const sums = join(profile.keysDir, "SHA256SUMS");
    if (existsSync(sums) && existsSync(join(zkDir, "keys"))) checkArtifactHashes(zkDir, sums);
    prover = proofServerProver({
      url: proofServer,
      zkConfig: zkConfigForContract({
        artifactDir: zkDir,
        expectedVerifierKeys: committedVerifierKeys(profile),
      }),
      maxConcurrent: options.integer("proof-concurrency", 4, 64),
      onRetry: (event) => {
        log(
          `prover retry       ${event.endpoint} attempt ${String(event.attempt)} after ${event.reason}`,
        );
      },
    });
  }
  const latest = await indexer.latestBlock();
  if (latest.ledgerParametersHex === undefined) {
    throw new PublicDataError("shape", "the indexer did not return ledger parameters");
  }
  const parameters = ledgerParametersFromHex(latest.ledgerParametersHex);
  log(`opening wallet     (syncing with ${endpoints.indexer})`);
  const wallet = await openWallet(
    options,
    endpoints,
    proofServer,
    parameters.dust,
    log,
    dependencies,
  );
  try {
    await wallet.synced();
  } catch (error) {
    await wallet.close();
    throw error;
  }
  const services: ChainServices = {
    network: endpoints.network,
    stateSource: indexerStateSource(indexer),
    currentParameters: async () => {
      const block = await indexer.latestBlock();
      if (block.ledgerParametersHex === undefined) {
        throw new PublicDataError("shape", "the indexer did not return ledger parameters");
      }
      return {
        block: {
          hash: block.hash,
          height: block.height,
          timestampSeconds: Math.floor(block.timestampMs / 1000),
        },
        ledgerParameters: ledgerParametersFromHex(block.ledgerParametersHex),
      };
    },
    prover,
    balancer: wallet.balancer(),
    submitter: wallet.submitter(),
    coinPublicKey: wallet.coinPublicKey(),
    waitForInclusion: async (identifiers, timeoutMs) => {
      const found = await waitForTransaction(indexer, { identifiers }, { timeoutMs });
      return found === undefined ? undefined : toIncluded(found);
    },
    contractState: async (contract) => {
      const { state } = await indexer.contractState(contract);
      return state === undefined ? undefined : hexToBytes(state.stateHex);
    },
    proofTimeoutMs: options.integer("proof-timeout-seconds", 900) * 1000,
    requireProofs: dependencies.requireProofs ?? true,
    log,
  };
  return { services, close: () => wallet.close() };
};

const runChainCommand = async (
  command: "deploy" | "publish" | "pin",
  options: Options,
  io: Io,
  json: boolean,
  dependencies: ToolDependencies,
): Promise<number> => {
  const log = json ? io.err : io.out;
  const profile = profileOf(options.string("example"));
  const out = options.required("out", "a path for the public record");
  const ttlSeconds = options.integer("ttl-seconds", DEFAULT_TTL_SECONDS, DEFAULT_MAX_TTL_SECONDS);
  // Validate every flag before a wallet is opened.
  if (command !== "publish") {
    for (const flag of [
      "message",
      "message-hex",
      "message-file",
      "max-parts",
      "max-block-fraction",
      "dry-run",
    ]) {
      if (options.parsed.flags.has(flag)) throw new UsageError(`--${flag} is for publish`);
    }
  }
  let run: (services: ChainServices) => Promise<unknown>;
  if (command === "deploy") {
    const emitterSecretFile = options.required(
      "emitter-secret-file",
      "a path for the new emitter secret",
    );
    const maintenanceKeyFile = options.required(
      "maintenance-key-file",
      "a path for the new maintenance signing key",
    );
    const generated = await loadGeneratedModule(profile);
    const verifierKeys = committedVerifierKeys(profile);
    run = (services) =>
      runDeploy(services, {
        profile,
        generated,
        verifierKeys,
        emitterSecretFile,
        reuseSecret: options.has("reuse-secret"),
        maintenanceKeyFile,
        reuseMaintenanceKey: options.has("reuse-maintenance-key"),
        ttlSeconds,
        out,
      });
  } else {
    const address = hex32(options.required("contract", "the contract address"), "contract");
    const secretFile = options.required("emitter-secret-file", "the emitter secret file");
    const generated = await loadGeneratedModule(profile);
    if (command === "publish") {
      const messages = messagesOf(options, profile);
      if (messages.length === 0) {
        throw new UsageError("give at least one --message, --message-hex or --message-file");
      }
      const maxParts = options.integer("max-parts", DEFAULT_MAX_PARTS, MAX_PARTS_CEILING);
      const fraction = options.string("max-block-fraction");
      const maxBlockFraction = fraction === undefined ? 1 : Number(fraction);
      if (!(maxBlockFraction > 0 && maxBlockFraction <= 1)) {
        throw new UsageError("--max-block-fraction must be in (0, 1]");
      }
      run = (services) =>
        runPublish(services, {
          profile,
          generated,
          address,
          messages,
          secretFile,
          maxParts,
          ttlSeconds,
          maxBlockFraction,
          out,
          dryRun: options.has("dry-run"),
        });
    } else {
      if (profile.name !== "notice-board") {
        throw new UsageError("pin is the notice board's circuit: --example notice-board");
      }
      const digest = hexToBytes(hex32(options.required("digest", "the digest to pin"), "digest"));
      run = (services) =>
        runPin(services, {
          profile,
          generated,
          address,
          digest,
          secretFile,
          ttlSeconds,
          out,
        });
    }
  }
  const opened = await openChainServices(options, profile, command !== "deploy", log, dependencies);
  try {
    const result = await run(opened.services);
    if (json) io.out(JSON.stringify(jsonSafe(result), null, 2));
    return 0;
  } finally {
    await opened.close();
  }
};

const runFundingCommand = async (
  options: Options,
  io: Io,
  json: boolean,
  dependencies: ToolDependencies,
): Promise<number> => {
  const log = json ? io.err : io.out;
  const mode = options.string("register-dust");
  if (mode !== undefined && mode !== "estimate" && mode !== "register") {
    throw new UsageError("--register-dust is estimate or register");
  }
  const endpoints = resolveEndpoints(options);
  const proofServer = resolveProofServer(options);
  const indexer = new IndexerClient({ url: endpoints.indexer });
  const latest = await indexer.latestBlock();
  if (latest.ledgerParametersHex === undefined) {
    throw new PublicDataError("shape", "the indexer did not return ledger parameters");
  }
  const wallet = await openWallet(
    options,
    endpoints,
    proofServer,
    ledgerParametersFromHex(latest.ledgerParametersHex).dust,
    log,
    dependencies,
  );
  try {
    const report = await runFunding(wallet, mode === undefined ? {} : { registerDust: mode }, log);
    if (json) io.out(JSON.stringify(jsonSafe(report), null, 2));
    return 0;
  } finally {
    await wallet.close();
  }
};

/**
 * Run deploy-tools. Returns the exit status: 0 success, 1 failure, 2 usage or input
 * error, 3 not found.
 */
export const main = async (
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
  io: Io = consoleIo,
  dependencies: ToolDependencies = {},
): Promise<number> => {
  try {
    const parsed = parseArgs(argv, FLAGS);
    const options = new Options(parsed, env, ENV_FOR_FLAG);
    const json = options.has("json");
    if (options.has("help") || parsed.command === "help") {
      io.out(USAGE);
      return 0;
    }
    switch (parsed.command) {
      case undefined:
        io.err(USAGE);
        return 2;
      case "funding":
        return await runFundingCommand(options, io, json, dependencies);
      case "deploy":
      case "publish":
      case "pin":
        return await runChainCommand(parsed.command, options, io, json, dependencies);
      default:
        throw new UsageError(`unknown command '${parsed.command}'`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof WalletNotSyncedError) {
      io.err(`not synced: ${message}`);
      return 1;
    }
    if (
      error instanceof UsageError ||
      error instanceof SecretFileError ||
      error instanceof WalletCacheError ||
      error instanceof RangeError
    ) {
      io.err(`error: ${message}`);
      if (error instanceof UsageError) io.err("run `npm run deploy-tools -- --help` for usage");
      return 2;
    }
    if (error instanceof PublicDataError && error.kind === "not-found") {
      io.err(`not found: ${message}`);
      return 3;
    }
    if (error instanceof CommandFailure || error instanceof PackageCheckError) {
      io.err(`failed: ${message}`);
      return 1;
    }
    io.err(`failed: ${message}`);
    return 1;
  }
};

if (invokedDirectly(import.meta.url)) {
  // Exit explicitly (a wallet's indexer subscriptions can keep the event loop alive), but
  // only after the output is flushed.
  await exitAfterFlush(await main(process.argv.slice(2)));
}
