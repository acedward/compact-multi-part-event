#!/usr/bin/env node
/**
 * `cmse`: deploy the reference emitter or the consumer example, register and publish
 * messages, check a wallet's funding, and verify publications without a wallet.
 *
 * Configuration comes from flags or `CMSE_*` environment variables (see
 * `.env.example`). Secrets are only ever passed as file PATHS; no command prints one.
 *
 * @module
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  type IndexedTransaction,
  IndexerClient,
  indexerStateSource,
  ledgerParametersFromHex,
  PublicDataError,
  waitForTransaction,
} from "../adapters/indexer.js";
import { proofServerProver, proverFromEndpoint } from "../adapters/prover.js";
import { SecretFileError } from "../adapters/secrets.js";
import { WalletSession, type WalletSessionOptions } from "../adapters/wallet.js";
import { WalletCacheError } from "../adapters/wallet-cache.js";
import { WalletNotSyncedError } from "../adapters/wallet-sync.js";
import { checkArtifactHashes, zkConfigForContract } from "../adapters/zk-config.js";
import { hexToBytes } from "../codec/bytes.js";
import { FORMAT_MAX_PARTS } from "../codec/constants.js";
import {
  DEFAULT_MAX_PARTS,
  DEFAULT_TTL_SECONDS,
  PublicationCheckError,
  type PublicationBalancer,
  type PublicationSubmitter,
} from "../transaction/index.js";
import {
  type ChainServices,
  CommandFailure,
  type FundingWallet,
  type IncludedTransaction,
  jsonSafe,
  runDeploy,
  runFunding,
  runPublish,
  runRegister,
} from "./commands.js";
import {
  type Endpoints,
  Options,
  parseArgs,
  resolveEndpoints,
  resolveProofServer,
  UsageError,
} from "./config.js";
import {
  committedVerifierKeys,
  contractProfiles,
  type ContractProfile,
  loadGeneratedModule,
  provableCircuits,
} from "./contracts.js";
import { LEVEL_MEANING, verifyExitStatus, verifyPublication } from "./verify.js";

export const USAGE = `cmse — multi-segment event emission: deploy, register, publish, verify

  cmse funding  [--register-dust estimate|register]
  cmse deploy   --emitter-secret-file <new path> --maintenance-key-file <new path> [--out <record.json>]
  cmse deploy-consumer --maintenance-key-file <new path> [--out <record.json>]
  cmse register --contract <consumer address> (--message-file <path> | --message-hex <hex>)
                --owner-secret-file <path> [--new-owner-secret] [--out <record.json>]
  cmse publish  --contract <address> (--message-file <path> | --message-hex <hex>)
                [--kind emitter|consumer] (--emitter-secret-file | --owner-secret-file) <path>
                [--max-parts <n>] [--max-block-fraction <f>] [--record-out <record.json>] [--dry-run]
  cmse verify   --contract <address> --tx <transaction hash> [--level 1|2|3] [--kind emitter|consumer]
                [--request-id <hex>] [--verifier-key <file>] [--node <rpc url>] [--json]
  cmse verify   --contract <address> --raw-file <hex file> --status SUCCESS [--state-file <hex file>] ...

Network (flag or environment variable; defaults are stagenet's public endpoints):
  --network CMSE_NETWORK (stagenet)   --indexer CMSE_INDEXER_URL   --indexer-ws CMSE_INDEXER_WS_URL
  --node CMSE_NODE_URL                --proof-server CMSE_PROOF_SERVER_URL (loopback only, unless
  --allow-remote-prover)              --proof-concurrency CMSE_PROOF_CONCURRENCY (4)
  --zk-dir CMSE_ZK_DIR (build/zk/<contract>, from npm run compile:zk)
Secrets (paths only; files are mode 0600, outside every Git working tree):
  --wallet-mnemonic-file CMSE_WALLET_MNEMONIC_FILE   --emitter-secret-file CMSE_EMITTER_SECRET_FILE
  --owner-secret-file CMSE_OWNER_SECRET_FILE         --maintenance-key-file CMSE_MAINTENANCE_KEY_FILE
Wallet sync (every command that opens a wallet waits for a COMPLETE sync of the shielded,
unshielded and DUST wallets; a first sync downloads every ledger event and can take long):
  --sync-timeout-minutes CMSE_SYNC_TIMEOUT_MINUTES (60)   progress is printed every 30 s;
  --wallet-cache-file CMSE_WALLET_CACHE_FILE (optional; mode 0600, outside every Git working tree)
      saves the synced wallet state and restores it on the next run. It holds private wallet
      data (no keys): protect it like a secret file.
If the sync does not complete in time the command prints "not synced" and exits 1; balances
are never printed from an incomplete sync.

verify levels: 1 the message (complete canonical group, exact names, SHA-256); 2 the placement
(guaranteed-only emission calls in one included transaction, from the raw bytes; with --node the
bytes are also found in the node's block); 3 the code (deployed verifier key equals the repository's).
Exit status: 0 success/verified; 1 a check or transaction failed; 2 usage or input error;
3 not found (not indexed yet, or wrong hash/address).
`;

const VALUED = new Set([
  "network",
  "indexer",
  "indexer-ws",
  "node",
  "proof-server",
  "proof-concurrency",
  "wallet-mnemonic-file",
  "wallet-cache-file",
  "sync-timeout-minutes",
  "emitter-secret-file",
  "owner-secret-file",
  "maintenance-key-file",
  "zk-dir",
  "register-dust",
  "out",
  "record-out",
  "contract",
  "message-file",
  "message-hex",
  "kind",
  "max-parts",
  "max-block-fraction",
  "ttl-seconds",
  "tx",
  "level",
  "request-id",
  "verifier-key",
  "entry-point",
  "raw-file",
  "status",
  "state-file",
  "proof-timeout-seconds",
]);
const SWITCHES = new Set([
  "json",
  "help",
  "allow-remote-prover",
  "reuse-secret",
  "reuse-maintenance-key",
  "new-owner-secret",
  "dry-run",
]);

/** Output streams (injectable for tests). */
export interface Io {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/** What the CLI needs from a wallet ({@link WalletSession} provides it). */
export interface CliWallet extends FundingWallet {
  /** Resolves after a complete sync; throws `WalletNotSyncedError` otherwise. */
  synced(): Promise<unknown>;
  balancer(): PublicationBalancer;
  submitter(): PublicationSubmitter;
  coinPublicKey(): string;
  close(): Promise<void>;
}

/** Replaceable services of {@link main} (tests use stand-ins). */
export interface CliDependencies {
  /** Opens the wallet (default {@link WalletSession.open}). */
  readonly openWallet?: (options: WalletSessionOptions) => Promise<CliWallet>;
}

/** Open the wallet with the command line's sync and cache settings. */
const openWallet = async (
  options: Options,
  endpoints: Endpoints,
  proofServerUrl: string,
  dustParameters: WalletSessionOptions["dustParameters"],
  log: (line: string) => void,
  dependencies: CliDependencies,
): Promise<CliWallet> => {
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
    ...(stateCacheFile === undefined ? {} : { stateCacheFile }),
    log,
  });
};

const address = (options: Options): string => {
  const value = options
    .required("contract", "a contract address")
    .replace(/^0x/iu, "")
    .toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new UsageError("--contract must be 64 hex characters");
  return value;
};

const profileOf = (options: Options): ContractProfile => {
  const kind = options.string("kind") ?? "emitter";
  if (kind !== "emitter" && kind !== "consumer")
    throw new UsageError("--kind is emitter or consumer");
  return contractProfiles()[kind];
};

const readHexOrBytesFile = (path: string): Uint8Array => {
  if (!existsSync(path)) throw new UsageError(`${path} does not exist`);
  const raw = readFileSync(path);
  const text = raw.toString("utf8").trim();
  return /^[0-9a-fA-F]+$/u.test(text) && text.length % 2 === 0
    ? hexToBytes(text.toLowerCase())
    : new Uint8Array(raw);
};

const messageOf = (options: Options): Uint8Array => {
  const file = options.string("message-file");
  const hex = options.string("message-hex");
  if ((file === undefined) === (hex === undefined)) {
    throw new UsageError("pass exactly one of --message-file and --message-hex");
  }
  if (file !== undefined) {
    if (!existsSync(file)) throw new UsageError(`${file} does not exist`);
    return new Uint8Array(readFileSync(file));
  }
  const clean = (hex ?? "").replace(/^0x/iu, "").toLowerCase();
  if (!/^([0-9a-f]{2})*$/u.test(clean)) throw new UsageError("--message-hex must be hex");
  return hexToBytes(clean);
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

interface OpenedServices {
  readonly services: ChainServices;
  close(): Promise<void>;
}

const openChainServices = async (
  options: Options,
  profile: ContractProfile,
  proves: boolean,
  log: (line: string) => void,
  dependencies: CliDependencies,
): Promise<OpenedServices> => {
  const endpoints = resolveEndpoints(options);
  const proofServer = resolveProofServer(options);
  const indexer = new IndexerClient({ url: endpoints.indexer });
  const latest = await indexer.latestBlock();
  if (latest.ledgerParametersHex === undefined) {
    throw new PublicDataError("shape", "the indexer did not return ledger parameters");
  }
  const parameters = ledgerParametersFromHex(latest.ledgerParametersHex);
  let prover = proverFromEndpoint(noCallsEndpoint);
  if (proves) {
    const zkDir = options.string("zk-dir") ?? profile.zkDir;
    const sums = join(profile.keysDir, "SHA256SUMS");
    if (existsSync(sums)) checkArtifactHashes(zkDir, sums);
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
  const source = indexerStateSource(indexer);
  const services: ChainServices = {
    network: endpoints.network,
    stateSource: source,
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
    requireProofs: true,
    log,
  };
  return { services, close: () => wallet.close() };
};

const runVerify = async (options: Options, io: Io, json: boolean): Promise<number> => {
  const profile = profileOf(options);
  const entryPoint = options.string("entry-point") ?? "emitPart";
  const level = options.integer("level", 3, 3);
  const keyPath = options.string("verifier-key") ?? join(profile.keysDir, `${entryPoint}.verifier`);
  const rawFile = options.string("raw-file");
  const common = {
    network: options.string("network") ?? "stagenet",
    contract: address(options),
    entryPoint,
    level,
    ...(options.string("request-id") === undefined
      ? {}
      : { requestId: (options.string("request-id") ?? "").replace(/^0x/iu, "").toLowerCase() }),
    ...(level >= 3 && existsSync(keyPath)
      ? { expectedVerifierKey: new Uint8Array(readFileSync(keyPath)) }
      : {}),
  };
  if (level >= 3 && common.expectedVerifierKey === undefined) {
    throw new UsageError(`Level 3 needs the expected verifier key; ${keyPath} does not exist`);
  }
  let report;
  if (rawFile !== undefined) {
    const stateFile = options.string("state-file");
    report = await verifyPublication({
      ...common,
      rawTransaction: readHexOrBytesFile(rawFile),
      status: options.required("status", "the inclusion status (SUCCESS or PARTIAL_SUCCESS)"),
      ...(options.string("tx") === undefined
        ? {}
        : { transactionHash: options.string("tx") ?? "" }),
      ...(stateFile === undefined ? {} : { contractStateBytes: readHexOrBytesFile(stateFile) }),
    });
  } else {
    const endpoints = resolveEndpoints(options, { node: false });
    const node = options.flags.get("node");
    report = await verifyPublication({
      ...common,
      network: endpoints.network,
      indexer: new IndexerClient({ url: endpoints.indexer }),
      transactionHash: options
        .required("tx", "a transaction hash")
        .replace(/^0x/iu, "")
        .toLowerCase(),
      ...(typeof node === "string" ? { nodeUrl: node } : {}),
    });
  }
  const print = json ? io.err : io.out;
  if (report.transaction !== undefined) {
    print(
      `transaction ${report.transaction.hash}${report.transaction.blockHeight === undefined ? "" : ` at block ${String(report.transaction.blockHeight)}`}${report.transaction.status === undefined ? "" : `, status ${report.transaction.status}`}`,
    );
  }
  for (const key of ["level1", "level2", "level3"]) {
    for (const line of report.levels[key]?.lines ?? []) print(line);
  }
  if (report.notFound) print("not found: the transaction or its events are not indexed (yet)");
  print(`verified up to level ${String(report.level)} — ${LEVEL_MEANING[report.level] ?? ""}`);
  if (json) io.out(JSON.stringify(jsonSafe(report), null, 2));
  return verifyExitStatus(report);
};

const runChainCommand = async (
  command: string,
  options: Options,
  io: Io,
  json: boolean,
  dependencies: CliDependencies,
): Promise<number> => {
  const log = json ? io.err : io.out;
  const profile =
    command === "deploy"
      ? contractProfiles().emitter
      : command === "deploy-consumer" || command === "register"
        ? contractProfiles().consumer
        : profileOf(options);
  const generated = await loadGeneratedModule(profile);
  const proves = command === "register" || command === "publish";
  const opened = await openChainServices(options, profile, proves, log, dependencies);
  try {
    let result: unknown;
    const ttlSeconds = options.integer("ttl-seconds", DEFAULT_TTL_SECONDS, 3600);
    if (command === "deploy" || command === "deploy-consumer") {
      const out = options.string("out");
      result = await runDeploy(opened.services, {
        profile,
        generated,
        verifierKeys: committedVerifierKeys(profile),
        ...(command === "deploy"
          ? {
              emitterSecretFile: options.required(
                "emitter-secret-file",
                "a path for the new emitter secret",
              ),
            }
          : {}),
        reuseSecret: options.has("reuse-secret"),
        maintenanceKeyFile: options.required(
          "maintenance-key-file",
          "a path for the new maintenance signing key",
        ),
        reuseMaintenanceKey: options.has("reuse-maintenance-key"),
        ttlSeconds,
        ...(out === undefined ? {} : { out }),
      });
    } else if (command === "register") {
      const out = options.string("out");
      result = await runRegister(opened.services, {
        profile,
        generated,
        address: address(options),
        message: messageOf(options),
        ownerSecretFile: options.required("owner-secret-file", "the owner secret file"),
        createOwnerSecret: options.has("new-owner-secret"),
        ttlSeconds,
        circuits: provableCircuits(profile),
        ...(out === undefined ? {} : { out }),
      });
    } else {
      const recordOut = options.string("record-out");
      const fraction = options.string("max-block-fraction");
      const maxBlockFraction = fraction === undefined ? 1 : Number(fraction);
      if (!(maxBlockFraction > 0 && maxBlockFraction <= 1)) {
        throw new UsageError("--max-block-fraction must be in (0, 1]");
      }
      result = await runPublish(opened.services, {
        profile,
        generated,
        address: address(options),
        message: messageOf(options),
        secretFile:
          profile.access === "whitelist"
            ? options.required("emitter-secret-file", "the emitter secret file")
            : options.required("owner-secret-file", "the owner secret file"),
        maxParts: options.integer("max-parts", DEFAULT_MAX_PARTS, FORMAT_MAX_PARTS),
        ttlSeconds,
        maxBlockFraction,
        dryRun: options.has("dry-run"),
        ...(recordOut === undefined ? {} : { recordOut }),
      });
    }
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
  dependencies: CliDependencies,
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
 * Run the CLI. Returns the exit status: 0 success, 1 failure, 2 usage or input error,
 * 3 not found.
 */
export const main = async (
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
  io: Io = { out: (line) => console.log(line), err: (line) => console.error(line) },
  dependencies: CliDependencies = {},
): Promise<number> => {
  try {
    const parsed = parseArgs(argv, VALUED, SWITCHES);
    const options = new Options(parsed.flags, env);
    const json = options.has("json");
    if (options.has("help") || parsed.command === undefined || parsed.command === "help") {
      io.out(USAGE);
      return parsed.command === undefined && !options.has("help") ? 2 : 0;
    }
    switch (parsed.command) {
      case "verify":
        return await runVerify(options, io, json);
      case "funding":
        return await runFundingCommand(options, io, json, dependencies);
      case "deploy":
      case "deploy-consumer":
      case "register":
      case "publish":
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
      if (error instanceof UsageError) io.err("run `cmse --help` for usage");
      return 2;
    }
    if (error instanceof PublicDataError && error.kind === "not-found") {
      io.err(`not found: ${message}`);
      return 3;
    }
    if (error instanceof CommandFailure || error instanceof PublicationCheckError) {
      io.err(`failed: ${message}`);
      return 1;
    }
    io.err(`failed: ${message}`);
    return 1;
  }
};

const invokedDirectly = (): boolean => {
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(script)).href;
  } catch {
    return false;
  }
};

if (invokedDirectly()) {
  // Exit explicitly: a wallet's indexer subscriptions can keep the event loop alive.
  process.exit(await main(process.argv.slice(2)));
}
