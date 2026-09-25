/**
 * deploy-tools configuration: the flags' environment variables, the network's endpoints
 * and the proof server. Argument parsing is the library CLI's (`src/cli/options`).
 * Secrets are only ever given as file PATHS.
 *
 * @module
 */
import {
  httpUrl,
  indexerUrlOf,
  NETWORK_DEFAULTS,
  networkOf,
  type Options,
  UsageError,
} from "../src/cli/options.js";

/** Environment variable backing each flag (only these are read; flags win). */
export const ENV_FOR_FLAG: Readonly<Record<string, string>> = {
  network: "CMSE_NETWORK",
  indexer: "CMSE_INDEXER_URL",
  "indexer-ws": "CMSE_INDEXER_WS_URL",
  node: "CMSE_NODE_URL",
  "proof-server": "CMSE_PROOF_SERVER_URL",
  "proof-concurrency": "CMSE_PROOF_CONCURRENCY",
  "wallet-mnemonic-file": "CMSE_WALLET_MNEMONIC_FILE",
  "wallet-cache-file": "CMSE_WALLET_CACHE_FILE",
  "sync-timeout-minutes": "CMSE_SYNC_TIMEOUT_MINUTES",
  "fee-blocks-margin": "CMSE_FEE_BLOCKS_MARGIN",
  "emitter-secret-file": "CMSE_EMITTER_SECRET_FILE",
  "maintenance-key-file": "CMSE_MAINTENANCE_KEY_FILE",
  "zk-dir": "CMSE_ZK_DIR",
};

/** Resolved endpoints. */
export interface Endpoints {
  readonly network: string;
  readonly indexer: string;
  readonly indexerWs: string;
  readonly node: string;
}

/**
 * Network id and endpoints, from flags/environment or the network's defaults.
 *
 * @throws {UsageError} For an unknown network without explicit endpoints, or a bad URL.
 */
export const resolveEndpoints = (options: Options): Endpoints => {
  const network = networkOf(options);
  const defaults = NETWORK_DEFAULTS[network];
  const indexer = indexerUrlOf(options, network);
  const node = options.string("node") ?? defaults?.node;
  if (node === undefined) {
    throw new UsageError(`network '${network}' has no default node; pass --node`);
  }
  const indexerWs =
    options.string("indexer-ws") ??
    defaults?.indexerWs ??
    `${indexer.replace(/^http/u, "ws").replace(/\/$/u, "")}/ws`;
  return { network, indexer, indexerWs, node: httpUrl(node, "node") };
};

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * The proof server URL. The proof server sees every witness (the emitter secret), so
 * only a loopback address is accepted unless `--allow-remote-prover` is given (for a
 * proof server you run on a private Docker network, for example).
 *
 * @throws {UsageError} For a missing, malformed or remote URL.
 */
export const resolveProofServer = (options: Options): string => {
  const url = httpUrl(options.required("proof-server", "a proof server URL"), "proof-server");
  const { hostname } = new URL(url);
  if (!LOOPBACK.has(hostname) && !options.has("allow-remote-prover")) {
    throw new UsageError(
      `the proof server ${hostname} is not a loopback address; it would see your witness secrets. Run it locally, or pass --allow-remote-prover for one you control`,
    );
  }
  return url;
};
