/**
 * Command-line plumbing shared by `cmse` and this repository's deploy-tools: argument
 * parsing, flags with environment-variable fallbacks, the public networks' endpoints,
 * JSON-safe output and an exit that waits for the output to be flushed.
 *
 * Secrets are never flags or variables' values: tools take file PATHS.
 *
 * @module
 */
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { bytesToHex } from "../reader/bytes.js";

/** A usage or input error (exit status 2). */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** Which flags a command line accepts. */
export interface FlagSpec {
  /** Flags that take a value. */
  readonly valued: ReadonlySet<string>;
  /** Flags that take none. */
  readonly switches: ReadonlySet<string>;
  /** Valued flags that may be given more than once (every value is kept, in order). */
  readonly repeatable?: ReadonlySet<string>;
}

/** Parsed command line: the command and its flags. */
export interface ParsedArgs {
  readonly command: string | undefined;
  /** The value of each flag (the last one for a repeatable flag), or `true` for a switch. */
  readonly flags: ReadonlyMap<string, string | true>;
  /** Every value of each repeatable flag, in order. */
  readonly repeated: ReadonlyMap<string, readonly string[]>;
  /** Every value of every repeatable flag, in command-line order. */
  readonly sequence: readonly { readonly name: string; readonly value: string }[];
}

/**
 * Parse `command --flag value --flag=value --switch`.
 *
 * @throws {UsageError} On an unknown flag, a missing value, a stray argument, or a
 * non-repeatable flag given twice.
 */
export const parseArgs = (argv: readonly string[], spec: FlagSpec): ParsedArgs => {
  const flags = new Map<string, string | true>();
  const repeated = new Map<string, string[]>();
  const sequence: { name: string; value: string }[] = [];
  let command: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (!argument.startsWith("--")) {
      if (command !== undefined) throw new UsageError(`unexpected argument '${argument}'`);
      command = argument;
      continue;
    }
    const [name, inline] = argument.slice(2).split(/=(.*)/su, 2) as [string, string | undefined];
    if (spec.switches.has(name)) {
      if (inline !== undefined) throw new UsageError(`--${name} takes no value`);
      flags.set(name, true);
      continue;
    }
    if (!spec.valued.has(name)) throw new UsageError(`unknown option --${name}`);
    const value = inline ?? argv[index + 1];
    if (value === undefined || (inline === undefined && value.startsWith("--"))) {
      throw new UsageError(`--${name} needs a value`);
    }
    if (inline === undefined) index += 1;
    if (spec.repeatable?.has(name) === true) {
      repeated.set(name, [...(repeated.get(name) ?? []), value]);
      sequence.push({ name, value });
    } else if (flags.has(name)) {
      throw new UsageError(`--${name} is given twice`);
    }
    flags.set(name, value);
  }
  return { command, flags, repeated, sequence };
};

/** Reads flags, with environment-variable fallbacks for the flags that have one. */
export class Options {
  /**
   * @param parsed - The parsed command line.
   * @param env - The environment.
   * @param envForFlag - The environment variable backing each flag (only these are read).
   */
  constructor(
    readonly parsed: ParsedArgs,
    readonly env: Readonly<Record<string, string | undefined>>,
    readonly envForFlag: Readonly<Record<string, string>>,
  ) {}

  /** A flag's value from the command line only (no environment fallback). */
  flag(name: string): string | undefined {
    const value = this.parsed.flags.get(name);
    return typeof value === "string" ? value : undefined;
  }

  /** A string flag or its environment variable (blank counts as unset), or `undefined`. */
  string(name: string): string | undefined {
    const value = this.flag(name);
    if (value !== undefined) return value;
    const variable = this.envForFlag[name];
    const fromEnv = variable === undefined ? undefined : this.env[variable];
    return fromEnv === undefined || fromEnv.trim() === "" ? undefined : fromEnv.trim();
  }

  /** Every value of a repeatable flag, in order. */
  values(name: string): readonly string[] {
    return this.parsed.repeated.get(name) ?? [];
  }

  /**
   * A required string flag.
   *
   * @throws {UsageError} Naming the flag and its variable.
   */
  required(name: string, what: string): string {
    const value = this.string(name);
    if (value === undefined) {
      const variable = this.envForFlag[name];
      throw new UsageError(
        `${what} is required: pass --${name}${variable === undefined ? "" : ` or set ${variable}`}`,
      );
    }
    return value;
  }

  /** A switch. */
  has(name: string): boolean {
    return this.parsed.flags.get(name) === true;
  }

  /**
   * An integer flag from `min` (default 1) to `max`, with a default.
   *
   * @throws {UsageError} If the value is not a decimal integer in range.
   */
  integer(name: string, fallback: number, max = Number.MAX_SAFE_INTEGER, min = 1): number {
    const text = this.string(name);
    if (text === undefined) return fallback;
    // Decimal digits only: `Number()` alone would read " " as 0 and "1e1" as 10.
    const value = /^[+-]?\d+$/u.test(text.trim()) ? Number(text.trim()) : Number.NaN;
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new UsageError(`--${name} must be an integer from ${String(min)} to ${String(max)}`);
    }
    return value;
  }
}

/** Public endpoints of a known network. */
export interface NetworkEndpoints {
  readonly indexer: string;
  readonly indexerWs: string;
  readonly node: string;
}

/** Known public networks and their endpoints (observed 2026-09-24). */
export const NETWORK_DEFAULTS: Readonly<Record<string, NetworkEndpoints>> = {
  stagenet: {
    indexer: "https://indexer.stagenet.shielded.tools/api/v4/graphql",
    indexerWs: "wss://indexer.stagenet.shielded.tools/api/v4/graphql/ws",
    node: "https://rpc.stagenet.shielded.tools",
  },
};

/** The network id (`--network`, default `stagenet`). */
export const networkOf = (options: Options): string => options.string("network") ?? "stagenet";

/**
 * Check that a flag's value is an http(s) URL.
 *
 * @throws {UsageError} Otherwise.
 */
export const httpUrl = (value: string, flag: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new UsageError(`--${flag} is not a URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new UsageError(`--${flag} must be an http(s) URL`);
  }
  return value;
};

/**
 * The indexer URL: `--indexer`, or the network's public indexer.
 *
 * @throws {UsageError} For an unknown network without `--indexer`, or a bad URL.
 */
export const indexerUrlOf = (options: Options, network = networkOf(options)): string => {
  const url = options.string("indexer") ?? NETWORK_DEFAULTS[network]?.indexer;
  if (url === undefined) {
    throw new UsageError(`network '${network}' has no default indexer; pass --indexer`);
  }
  return httpUrl(url, "indexer");
};

/**
 * A 32-byte value as 64 lowercase hex characters (an optional `0x` is dropped).
 *
 * @throws {UsageError} Otherwise.
 */
export const hex32 = (value: string, flag: string): string => {
  const hex = value.replace(/^0x/iu, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(hex)) throw new UsageError(`--${flag} must be 64 hex characters`);
  return hex;
};

/** JSON-safe copy: bigints as decimal strings, bytes as hex. */
export const jsonSafe = (value: unknown): unknown => {
  if (typeof value === "bigint") return value.toString(10);
  if (value instanceof Uint8Array) return bytesToHex(value);
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value instanceof Map) return Object.fromEntries([...value].map(([k, v]) => [k, jsonSafe(v)]));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonSafe(item)]));
  }
  return value;
};

/** Output streams (injectable for tests). */
export interface Io {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/** Standard output and standard error. */
export const consoleIo: Io = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

/** Whether the module at `moduleUrl` is the script Node was started with. */
export const invokedDirectly = (moduleUrl: string): boolean => {
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    return moduleUrl === pathToFileURL(realpathSync(script)).href;
  } catch {
    return false;
  }
};

/** The part of a writable stream {@link exitAfterFlush} waits on. */
export interface FlushableStream {
  readonly writableLength: number;
}

/**
 * Exit with `status` once stdout and stderr have handed everything written to them to
 * the operating system (bounded by `timeoutMs`). Calling `process.exit()` right after a
 * large write to a pipe cuts the output: a `--json` report can exceed a pipe's 64 KiB
 * buffer.
 */
export const exitAfterFlush = async (
  status: number,
  options: {
    readonly streams?: readonly FlushableStream[];
    readonly exit?: (code: number) => void;
    readonly timeoutMs?: number;
    readonly pollMs?: number;
  } = {},
): Promise<void> => {
  const streams = options.streams ?? [process.stdout, process.stderr];
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  while (streams.some((stream) => stream.writableLength > 0) && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, options.pollMs ?? 10));
  }
  (options.exit ?? ((code: number) => process.exit(code)))(status);
};
