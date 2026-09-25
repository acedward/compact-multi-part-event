#!/usr/bin/env node
/**
 * `cmse verify`: read and verify packages of the multi-part rule from public data,
 * without a wallet, proof server or compiler (see `./verify` for the three levels).
 *
 * @module
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { IndexerClient, PublicDataError } from "../indexer/index.js";
import { hexToBytes } from "../reader/bytes.js";
import { eventName } from "../reader/event.js";
import {
  consoleIo,
  exitAfterFlush,
  hex32,
  httpUrl,
  indexerUrlOf,
  invokedDirectly,
  type Io,
  jsonSafe,
  networkOf,
  Options,
  parseArgs,
  UsageError,
} from "./options.js";
import {
  indexerSource,
  type Level,
  reportLines,
  savedSource,
  verifyExitStatus,
  verifyPackages,
  type VerifySource,
} from "./verify.js";

export const USAGE = `cmse verify — read and verify packages of the multi-part rule from public data
(no wallet, proof server or compiler)

  cmse verify --contract <address> --name <event name> --tx <transaction hash> [--segment <n>]
      the packages of (contract, name) in one transaction (one per intent)
  cmse verify --contract <address> --name <event name>
      every package of (contract, name): pages through the contract's Misc events
  cmse verify --contract <address> --name <event name> --raw-file <file> --status <status>
              [--tx <transaction hash>] [--state-file <file>] [--segment <n>]
      offline: saved raw transaction bytes (hex or binary) and, for Level 3, the saved
      serialized contract state; no network

  --contract <address>        the contract (64 hex characters)
  --name <event name>         the opted-in event name N, e.g. 'example:message[v1]'
                              (quote it: [ ] are shell patterns), or 0x and 64 hex characters
  --entry-point <circuit>     the emitting circuit (default emitPart)
  --example <name>            this repository's examples, emitter or notice-board: sets --name
                              and the committed --verifier-key (run from a clone)
  --level 1|2|3               highest level to check (default 3)
  --verifier-key <file>       the committed verifier key of the emitting circuit (Level 3)
  --node <rpc url>            Level 2 also checks that the node's block holds the raw bytes
  --network <id>              CMSE_NETWORK (default stagenet)
  --indexer <url>             CMSE_INDEXER_URL (default: the network's public indexer;
                              stagenet: https://indexer.stagenet.shielded.tools/api/v4/graphql)
  --max-events <n>            largest number of events read (default 4096)
  --json                      print the report as JSON on stdout (the lines go to stderr)
  --help

Levels:
  1 the package: the contract's Misc events named N, grouped per intent (transaction and
    physical segment), in ledger emission order, widths restored, merged
  2 the placement, from the raw transaction: included (SUCCESS or PARTIAL_SUCCESS), the
    bytes hash to the transaction, every call of the emitting circuit in the package's
    intent is guaranteed-only and logs exactly its parts in order; with --node, the
    node's block holds the bytes
  3 the code: the contract's verifier key of the emitting circuit, at the transaction's
    block, equals the committed one

Exit status: 0 every package verified to the requested level; 1 a level failed;
2 usage or input error; 3 not found (not indexed yet, or a wrong hash, address or name).
`;

const FLAGS = {
  valued: new Set([
    "contract",
    "name",
    "entry-point",
    "example",
    "level",
    "verifier-key",
    "tx",
    "segment",
    "node",
    "network",
    "indexer",
    "max-events",
    "raw-file",
    "status",
    "state-file",
  ]),
  switches: new Set(["json", "help"]),
};

/** Environment variables `cmse` reads (flags win). */
export const ENV_FOR_FLAG: Readonly<Record<string, string>> = {
  network: "CMSE_NETWORK",
  indexer: "CMSE_INDEXER_URL",
};

/** This repository's example adopters. */
export const EXAMPLES: Readonly<
  Record<string, { readonly name: string; readonly keysDir: string }>
> = {
  emitter: { name: "example:message[v1]", keysDir: "contract-examples/emitter/keys" },
  "notice-board": {
    name: "notice-board:notice[v1]",
    keysDir: "contract-examples/notice-board/keys",
  },
};

/** The repository root (this file is `src/cli/` or `dist/cli/` below it). */
export const repositoryRoot = (): string =>
  resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Replaceable services of {@link main} (tests). */
export interface CmseDependencies {
  readonly fetch?: typeof fetch;
}

/** Read a file of hex text (whitespace and an optional 0x ignored) or raw bytes. */
const readBytesFile = (path: string, what: string): Uint8Array => {
  if (!existsSync(path)) throw new UsageError(`${what} ${path} does not exist`);
  const raw = readFileSync(path);
  const text = raw.toString("utf8").replace(/\s+/gu, "").replace(/^0x/iu, "");
  return /^[0-9a-fA-F]+$/u.test(text) && text.length % 2 === 0
    ? hexToBytes(text.toLowerCase())
    : new Uint8Array(raw);
};

const nameOf = (options: Options, preset: string | undefined): string | Uint8Array => {
  const value = options.string("name") ?? preset;
  if (value === undefined) {
    throw new UsageError("the event name is required: pass --name <event name> (or --example)");
  }
  const bytes = /^0x([0-9a-fA-F]{64})$/u.exec(value)?.[1];
  const name = bytes === undefined ? value : hexToBytes(bytes.toLowerCase());
  try {
    eventName(name);
  } catch (error) {
    throw new UsageError(`--name: ${error instanceof Error ? error.message : String(error)}`);
  }
  return name;
};

const runVerify = async (
  options: Options,
  io: Io,
  dependencies: CmseDependencies,
): Promise<number> => {
  const exampleName = options.string("example");
  const example = exampleName === undefined ? undefined : EXAMPLES[exampleName];
  if (exampleName !== undefined && example === undefined) {
    throw new UsageError(`--example is ${Object.keys(EXAMPLES).join(" or ")}`);
  }
  const contract = hex32(options.required("contract", "the contract address"), "contract");
  const name = nameOf(options, example?.name);
  const entryPoint = options.string("entry-point") ?? "emitPart";
  const level = options.integer("level", 3, 3) as Level;
  const keyPath =
    options.string("verifier-key") ??
    (example === undefined
      ? undefined
      : join(repositoryRoot(), example.keysDir, `${entryPoint}.verifier`));
  if (level >= 3 && keyPath === undefined) {
    throw new UsageError(
      "Level 3 needs the committed verifier key: pass --verifier-key <file> (or --example), or --level 2",
    );
  }
  const expectedVerifierKey =
    level >= 3 && keyPath !== undefined ? readBytesFile(keyPath, "verifier key") : undefined;
  const txFlag = options.string("tx");
  const transactionHash = txFlag === undefined ? undefined : hex32(txFlag, "tx");
  const segmentFlag = options.string("segment");
  const segment = segmentFlag === undefined ? undefined : options.integer("segment", 1, 65535);
  const maxEvents = options.integer("max-events", 4096, 1_000_000);
  const network = networkOf(options);
  const rawFile = options.string("raw-file");
  const node = options.flag("node");

  let source: VerifySource;
  if (rawFile !== undefined) {
    if (node !== undefined) {
      throw new UsageError("--node needs the indexer's block: it does not work with --raw-file");
    }
    if (options.flag("indexer") !== undefined) {
      throw new UsageError("--raw-file verifies offline: drop --indexer");
    }
    const stateFile = options.string("state-file");
    if (level >= 3 && stateFile === undefined) {
      throw new UsageError("offline Level 3 needs --state-file (or --level 2)");
    }
    source = savedSource({
      network,
      raw: readBytesFile(rawFile, "raw transaction file"),
      status: options.required("status", "the inclusion status the chain reported"),
      ...(transactionHash === undefined ? {} : { transactionHash }),
      ...(stateFile === undefined
        ? {}
        : { contractState: readBytesFile(stateFile, "contract state file") }),
    });
  } else {
    for (const offline of ["status", "state-file"]) {
      if (options.flag(offline) !== undefined) {
        throw new UsageError(`--${offline} is for offline verification with --raw-file`);
      }
    }
    if (segment !== undefined && transactionHash === undefined) {
      throw new UsageError("--segment needs --tx");
    }
    source = indexerSource(
      new IndexerClient({
        url: indexerUrlOf(options, network),
        ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
      }),
      {
        network,
        maxEvents,
        ...(node === undefined ? {} : { nodeUrl: httpUrl(node, "node") }),
        ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
      },
    );
  }
  const report = await verifyPackages(source, {
    target: { network, contract, name, entryPoint },
    level,
    ...(transactionHash === undefined ? {} : { transactionHash }),
    ...(segment === undefined ? {} : { segment }),
    ...(expectedVerifierKey === undefined ? {} : { expectedVerifierKey }),
    crossCheckNode: node !== undefined,
    limits: { maxEvents, maxPackages: maxEvents },
  });
  const json = options.has("json");
  for (const line of reportLines(report)) (json ? io.err : io.out)(line);
  if (json) io.out(JSON.stringify(jsonSafe(report), null, 2));
  return verifyExitStatus(report);
};

/**
 * Run `cmse`. Returns the exit status: 0 verified, 1 a level failed (or the source
 * failed), 2 usage or input error, 3 not found.
 */
export const main = async (
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
  io: Io = consoleIo,
  dependencies: CmseDependencies = {},
): Promise<number> => {
  try {
    const parsed = parseArgs(argv, FLAGS);
    const options = new Options(parsed, env, ENV_FOR_FLAG);
    if (options.has("help") || parsed.command === "help") {
      io.out(USAGE);
      return 0;
    }
    if (parsed.command === undefined) {
      io.err(USAGE);
      return 2;
    }
    if (parsed.command !== "verify") {
      throw new UsageError(`unknown command '${parsed.command}' (cmse has one command: verify)`);
    }
    return await runVerify(options, io, dependencies);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof UsageError || error instanceof RangeError) {
      io.err(`error: ${message}`);
      if (error instanceof UsageError) io.err("run `cmse --help` for usage");
      return 2;
    }
    if (error instanceof PublicDataError && error.kind === "not-found") {
      io.err(`not found: ${message}`);
      return 3;
    }
    io.err(`failed: ${message}`);
    return 1;
  }
};

if (invokedDirectly(import.meta.url)) {
  await exitAfterFlush(await main(process.argv.slice(2)));
}
