/**
 * Command-line argument parsing and configuration from flags and environment
 * variables. Flags win over environment variables; secrets are only ever given as
 * file PATHS.
 *
 * @module
 */

/** A usage or input error (exit status 2). */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** Parsed command line: the command and its flags. */
export interface ParsedArgs {
  readonly command: string | undefined;
  readonly flags: ReadonlyMap<string, string | true>;
}

/**
 * Parse `command --flag value --flag=value --switch`. Every flag must be listed in
 * `valued` (takes a value) or `switches` (takes none).
 *
 * @throws {UsageError} On an unknown flag, a missing value or a stray argument.
 */
export const parseArgs = (
  argv: readonly string[],
  valued: ReadonlySet<string>,
  switches: ReadonlySet<string>,
): ParsedArgs => {
  const flags = new Map<string, string | true>();
  let command: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (!argument.startsWith("--")) {
      if (command !== undefined) throw new UsageError(`unexpected argument '${argument}'`);
      command = argument;
      continue;
    }
    const [name, inline] = argument.slice(2).split(/=(.*)/su, 2) as [string, string | undefined];
    if (switches.has(name)) {
      if (inline !== undefined) throw new UsageError(`--${name} takes no value`);
      flags.set(name, true);
    } else if (valued.has(name)) {
      const value = inline ?? argv[index + 1];
      if (value === undefined || (inline === undefined && value.startsWith("--"))) {
        throw new UsageError(`--${name} needs a value`);
      }
      if (inline === undefined) index += 1;
      flags.set(name, value);
    } else {
      throw new UsageError(`unknown option --${name}`);
    }
  }
  return { command, flags };
};

/** Environment variable backing each flag (only these are read). */
export const ENV_FOR_FLAG: Readonly<Record<string, string>> = {
  network: "CMSE_NETWORK",
  indexer: "CMSE_INDEXER_URL",
  "indexer-ws": "CMSE_INDEXER_WS_URL",
  node: "CMSE_NODE_URL",
  "proof-server": "CMSE_PROOF_SERVER_URL",
  "proof-concurrency": "CMSE_PROOF_CONCURRENCY",
  "wallet-mnemonic-file": "CMSE_WALLET_MNEMONIC_FILE",
  "emitter-secret-file": "CMSE_EMITTER_SECRET_FILE",
  "owner-secret-file": "CMSE_OWNER_SECRET_FILE",
  "maintenance-key-file": "CMSE_MAINTENANCE_KEY_FILE",
  "zk-dir": "CMSE_ZK_DIR",
};

/** Known public networks and their endpoints (observed 2026-09-23). */
export const NETWORK_DEFAULTS: Readonly<
  Record<string, { readonly indexer: string; readonly indexerWs: string; readonly node: string }>
> = {
  stagenet: {
    indexer: "https://indexer.stagenet.shielded.tools/api/v4/graphql",
    indexerWs: "wss://indexer.stagenet.shielded.tools/api/v4/graphql/ws",
    node: "https://rpc.stagenet.shielded.tools",
  },
};

/** Reads flags with environment fallbacks. */
export class Options {
  constructor(
    readonly flags: ReadonlyMap<string, string | true>,
    readonly env: Readonly<Record<string, string | undefined>>,
  ) {}

  /** A string flag (or its environment variable), or `undefined`. */
  string(name: string): string | undefined {
    const value = this.flags.get(name);
    if (typeof value === "string") return value;
    const variable = ENV_FOR_FLAG[name];
    const fromEnv = variable === undefined ? undefined : this.env[variable];
    return fromEnv === undefined || fromEnv.trim() === "" ? undefined : fromEnv.trim();
  }

  /** A required string flag. */
  required(name: string, what: string): string {
    const value = this.string(name);
    if (value === undefined) {
      const variable = ENV_FOR_FLAG[name];
      throw new UsageError(
        `${what} is required: pass --${name}${variable === undefined ? "" : ` or set ${variable}`}`,
      );
    }
    return value;
  }

  /** A boolean switch. */
  has(name: string): boolean {
    return this.flags.get(name) === true;
  }

  /** A positive integer flag with a default. */
  integer(name: string, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
    const text = this.string(name);
    if (text === undefined) return fallback;
    const value = Number(text);
    if (!Number.isSafeInteger(value) || value < 1 || value > max) {
      throw new UsageError(`--${name} must be an integer from 1 to ${String(max)}`);
    }
    return value;
  }
}

/** Resolved endpoints. */
export interface Endpoints {
  readonly network: string;
  readonly indexer: string;
  readonly indexerWs: string;
  /** Node RPC; empty when not needed and not configured (wallet-free commands). */
  readonly node: string;
}

/**
 * Network id and endpoints, from flags/environment or the network's defaults. The node
 * URL is required only for commands that open a wallet.
 */
export const resolveEndpoints = (
  options: Options,
  requirement: { readonly node: boolean } = { node: true },
): Endpoints => {
  const network = options.string("network") ?? "stagenet";
  const defaults = NETWORK_DEFAULTS[network];
  const indexer = options.string("indexer") ?? defaults?.indexer;
  const node = options.string("node") ?? defaults?.node ?? "";
  if (indexer === undefined) {
    throw new UsageError(`network '${network}' has no default endpoints; pass --indexer`);
  }
  if (requirement.node && node === "") {
    throw new UsageError(`network '${network}' has no default node; pass --node`);
  }
  const indexerWs =
    options.string("indexer-ws") ??
    defaults?.indexerWs ??
    `${indexer.replace(/^http/u, "ws").replace(/\/$/u, "")}/ws`;
  for (const [name, url] of [
    ["indexer", indexer],
    ...(node === "" ? [] : [["node", node] as const]),
  ] as const) {
    try {
      new URL(url);
    } catch {
      throw new UsageError(`--${name} is not a URL`);
    }
  }
  return { network, indexer, indexerWs, node };
};

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * The proof server URL. The proof server sees every witness (the emitter or owner
 * secret), so only a loopback address is accepted unless `--allow-remote-prover` is
 * given (for a proof server you run on a private Docker network, for example).
 */
export const resolveProofServer = (options: Options): string => {
  const url = options.required("proof-server", "a proof server URL");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UsageError("--proof-server is not a URL");
  }
  if (!LOOPBACK.has(parsed.hostname) && !options.has("allow-remote-prover")) {
    throw new UsageError(
      `the proof server ${parsed.hostname} is not a loopback address; it would see your witness secrets. Run it locally, or pass --allow-remote-prover for one you control`,
    );
  }
  return url;
};
