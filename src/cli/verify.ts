/**
 * Wallet-free verification of packages of the multi-part rule, for one configured
 * (contract, event name N) and its emitting circuit, in three levels:
 *
 * - Level 1, the package: the contract's `Misc` events named N, grouped per intent
 *   (transaction and physical segment), ordered by ledger emission order, widths
 *   restored and merged. From the indexer the source is each event's raw ledger bytes
 *   (they carry the intent); offline it is the saved raw transaction.
 * - Level 2, the placement, from the raw transaction bytes: the transaction is
 *   included (`SUCCESS` or `PARTIAL_SUCCESS`) and the bytes hash to it; every call of
 *   the emitting circuit of the contract in the package's intent is guaranteed-only,
 *   and those calls log exactly the package's parts, in order; the raw bytes show no
 *   package the events lack. With a node, the node's block must also hold the bytes.
 * - Level 3, the code: the verifier key the contract stored for the emitting circuit,
 *   at the transaction's block, equals the expected (committed) key.
 *
 * Proofs are not re-verified: inclusion means the network verified them.
 *
 * Without a transaction hash every package of the (contract, N) is listed, from the
 * contract's events (`contractEvents(filter: { contractAddress, types: [MISC] })`,
 * paged: the indexer has no name filter), and each is verified to the requested level.
 *
 * @module
 */
import { createHash } from "node:crypto";

import {
  type IndexedMiscEvent,
  type IndexerClient,
  partEventsFromIndexer,
  rawTransactionInBlock,
} from "../indexer/index.js";
import { bytesToHex, compareCodeUnits, hexToBytes } from "../reader/bytes.js";
import { eventName, eventNameText } from "../reader/event.js";
import {
  DEFAULT_READER_LIMITS,
  type Package,
  type PartEvent,
  readPackages,
  type ReaderLimits,
} from "../reader/packages.js";
import {
  type AnyTransaction,
  checkPlacement,
  deserializeTransaction,
  INCLUDED_STATUSES,
  partEventsFromTransaction,
  transactionHashOf,
} from "../reader/transaction.js";
import { compareDeployedVerifierKey, verifierKeySha256 } from "./verifier-key.js";

/** A verification level. */
export type Level = 1 | 2 | 3;

/** What to verify: an opted-in (contract, N) and its emitting circuit. */
export interface VerifyTarget {
  /** Network the source belongs to (the indexer does not report it). */
  readonly network: string;
  /** Contract address, 64 lowercase hex characters. */
  readonly contract: string;
  /** The event name N (text, padded to 32 bytes, or its 32 bytes). */
  readonly name: string | Uint8Array;
  /** The emitting circuit, e.g. `emitPart`. */
  readonly entryPoint: string;
}

/** A block reference. */
export interface BlockRef {
  readonly hash: string;
  readonly height: number;
}

/** A transaction as a source reports it. */
export interface SourceTransaction {
  readonly hash: string;
  readonly raw: Uint8Array;
  /** Inclusion status (`SUCCESS`, `PARTIAL_SUCCESS`, `FAILURE`). */
  readonly status: string;
  readonly block?: BlockRef;
}

/** A contract's events as reader input. */
export interface SourceEvents {
  readonly events: readonly PartEvent[];
  /** Events that could not be read, by transaction hash: its packages may be incomplete. */
  readonly issues: ReadonlyMap<string, readonly string[]>;
  /** The block of each transaction, when the source knows it. */
  readonly blocks: ReadonlyMap<string, BlockRef>;
  /** Events fetched. */
  readonly count: number;
}

/** Where verification reads public data from. */
export interface VerifySource {
  /** For reports, e.g. `indexer https://…`. */
  readonly description: string;
  /** The contract's `Misc` events (of one transaction, when given). */
  events(contract: string, transactionHash?: string): Promise<SourceEvents>;
  /** A transaction by hash, or `undefined` if the source does not have it. */
  transaction(hash: string): Promise<SourceTransaction | undefined>;
  /** The contract's serialized state as of a block (latest when omitted). */
  contractState(contract: string, block?: BlockRef): Promise<Uint8Array | undefined>;
  /** The node cross-check: the index of the block's extrinsic holding the bytes. */
  readonly nodeHolds?: (blockHash: string, raw: Uint8Array) => Promise<number | undefined>;
}

/** What {@link verifyPackages} checks. */
export interface VerifyRequest {
  readonly target: VerifyTarget;
  /** Highest level to check. */
  readonly level: Level;
  /** One transaction; without it every package of the (contract, N) is listed. */
  readonly transactionHash?: string;
  /** Only the package of this intent (needs `transactionHash`). */
  readonly segment?: number;
  /** The committed verifier key of the emitting circuit (Level 3). */
  readonly expectedVerifierKey?: Uint8Array;
  /** Also check that the node's block holds the raw bytes (Level 2). */
  readonly crossCheckNode?: boolean;
  /** Reader bounds. */
  readonly limits?: ReaderLimits;
}

/** One check's outcome. */
export interface Check {
  readonly level: Level;
  readonly ok: boolean;
  readonly message: string;
}

/** One package's verification. */
export interface PackageReport {
  readonly transactionHash: string;
  /** Physical segment: the package's intent. */
  readonly segment: number;
  readonly block?: BlockRef;
  /** Inclusion status (from Level 2 on). */
  readonly status?: string;
  readonly parts: number;
  readonly payloadBytes: number;
  /** SHA-256 of the merged payload (accepted packages). */
  readonly payloadSha256?: string;
  /** The merged payload, hex: what the adopting protocol processes. */
  readonly payloadHex?: string;
  /** Highest level passed (every lower level passed too). */
  readonly level: 0 | Level;
  readonly checks: readonly Check[];
}

/** The verification report. */
export interface VerifyReport {
  readonly source: string;
  readonly mode: "transaction" | "listing";
  readonly network: string;
  readonly contract: string;
  /** N in readable form. */
  readonly name: string;
  /** N as 32 bytes, hex. */
  readonly nameHex: string;
  readonly entryPoint: string;
  readonly requestedLevel: Level;
  /** Lowest level any package reached (0 when there is none). */
  readonly level: 0 | Level;
  /** The transaction or the packages were not found. */
  readonly notFound: boolean;
  readonly transactionHash?: string;
  readonly segment?: number;
  /** `Misc` events of the contract read, and how many had another name. */
  readonly events: number;
  readonly otherEvents: number;
  readonly expectedVerifierKeySha256?: string;
  readonly packages: readonly PackageReport[];
  /** Report-wide notes (for example why nothing was found). */
  readonly notes: readonly string[];
}

/** What each level means, for the final line. */
export const LEVEL_MEANING: Readonly<Record<number, string>> = {
  0: "nothing verified",
  1: "the package: every event named N of one intent, in emission order, merged",
  2: "and its placement: guaranteed-only calls of the emitting circuit in one intent of an included transaction",
  3: "and the code: the deployed emitting circuit's verifier key is the committed one",
};

/**
 * Exit status: 0 every package verified to the requested level; 1 a level failed;
 * 3 not found (usage and input errors, status 2, are the caller's).
 */
export const verifyExitStatus = (report: VerifyReport): number =>
  report.notFound ? 3 : report.level >= report.requestedLevel ? 0 : 1;

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const ADDRESS = /^[0-9a-f]{64}$/;

/** Options for {@link indexerSource}. */
export interface IndexerSourceOptions {
  readonly network: string;
  /** Node RPC for the Level 2 cross-check. */
  readonly nodeUrl?: string;
  /** Largest number of events fetched (default 4096). */
  readonly maxEvents?: number;
  /** Injectable fetch for the node request (tests). */
  readonly fetch?: typeof fetch;
}

/**
 * The public indexer (and optionally a node) as a verification source. Events come
 * from `contractEvents` (paged, at most 500 per page); each event's raw ledger bytes
 * give its intent, and its id gives its position in ledger emission order.
 */
export const indexerSource = (
  client: IndexerClient,
  options: IndexerSourceOptions,
): VerifySource => ({
  description: `indexer ${client.url}`,
  events: async (contract, transactionHash) => {
    const indexed = await client.miscEvents(contract, {
      ...(transactionHash === undefined ? {} : { transactionHash }),
      maxEvents: options.maxEvents ?? DEFAULT_READER_LIMITS.maxEvents,
    });
    const byTransaction = new Map<string, IndexedMiscEvent[]>();
    const blocks = new Map<string, BlockRef>();
    for (const item of indexed) {
      byTransaction.set(item.transactionHash, [
        ...(byTransaction.get(item.transactionHash) ?? []),
        item,
      ]);
      if (item.blockHash.length > 0 && item.blockHeight >= 0) {
        blocks.set(item.transactionHash, { hash: item.blockHash, height: item.blockHeight });
      }
    }
    const events: PartEvent[] = [];
    const issues = new Map<string, string[]>();
    for (const [hash, items] of byTransaction) {
      const converted = partEventsFromIndexer(items, { network: options.network, contract });
      events.push(...converted.events);
      if (converted.issues.length > 0) issues.set(hash, converted.issues);
    }
    return { events, issues, blocks, count: indexed.length };
  },
  transaction: async (hash) => {
    const [found] = await client.transactionsByHash(hash);
    if (found === undefined) return undefined;
    return {
      hash: found.hash,
      raw: hexToBytes(found.rawHex),
      status: found.status ?? "",
      block: { hash: found.block.hash, height: found.block.height },
    };
  },
  contractState: async (contract, block) => {
    const { state } = await client.contractState(contract, block?.hash);
    return state === undefined ? undefined : hexToBytes(state.stateHex);
  },
  ...(options.nodeUrl === undefined
    ? {}
    : {
        nodeHolds: (blockHash: string, raw: Uint8Array) =>
          rawTransactionInBlock(
            options.nodeUrl ?? "",
            blockHash,
            bytesToHex(raw),
            options.fetch === undefined ? {} : { fetch: options.fetch },
          ),
      }),
});

/** Saved public data for offline verification. */
export interface SavedData {
  readonly network: string;
  /** Raw transaction bytes as the chain serves them. */
  readonly raw: Uint8Array;
  /** The inclusion status the chain reported. */
  readonly status: string;
  /** The transaction hash the chain reported (default: the bytes' own hash). */
  readonly transactionHash?: string;
  /** The contract's serialized state (Level 3). */
  readonly contractState?: Uint8Array;
  /** The block the transaction is in, if known. */
  readonly block?: BlockRef;
}

/**
 * Saved raw transaction bytes (and optionally the contract state) as a verification
 * source: Level 1 reads the packages from the raw bytes, so no indexer or network is
 * used.
 *
 * @throws {RangeError} If the bytes are not a ledger-v9 transaction, or carry no hash
 * and none is given.
 */
export const savedSource = (saved: SavedData): VerifySource => {
  let tx: AnyTransaction;
  try {
    tx = deserializeTransaction(saved.raw);
  } catch {
    throw new RangeError("the saved bytes are not a ledger-v9 transaction");
  }
  const hash = saved.transactionHash ?? transactionHashOf(tx);
  if (hash === undefined) {
    throw new RangeError(
      "the saved bytes carry no transaction hash; pass the one the chain reported",
    );
  }
  return {
    description: "saved raw transaction",
    events: (contract, transactionHash) => {
      if (transactionHash !== undefined && transactionHash !== hash) {
        return Promise.resolve({ events: [], issues: new Map(), blocks: new Map(), count: 0 });
      }
      const extracted = partEventsFromTransaction(tx, {
        network: saved.network,
        contract,
        transactionHash: hash,
      });
      return Promise.resolve({
        events: extracted.events,
        issues: new Map(extracted.issues.length === 0 ? [] : [[hash, extracted.issues]]),
        blocks: new Map(saved.block === undefined ? [] : [[hash, saved.block]]),
        count: extracted.events.length,
      });
    },
    transaction: (requested) =>
      Promise.resolve(
        requested === hash
          ? {
              hash,
              raw: saved.raw,
              status: saved.status,
              ...(saved.block === undefined ? {} : { block: saved.block }),
            }
          : undefined,
      ),
    contractState: () => Promise.resolve(saved.contractState),
  };
};

interface Entry {
  readonly transactionHash: string;
  readonly segment: number;
  /** The package from the events (Level 1). */
  readonly fromEvents?: Package;
  /** The package from the raw transaction, when only the raw bytes show it. */
  readonly rawOnly?: Package;
}

interface TransactionFacts {
  readonly transaction?: SourceTransaction;
  readonly decoded?: AnyTransaction;
  /** Transaction-wide Level 2 checks (status, hash, node). */
  readonly checks: readonly Check[];
}

const entryKey = (transactionHash: string, segment: number): string =>
  `${transactionHash}#${String(segment)}`;

const levelOf = (checks: readonly Check[], requested: Level): 0 | Level => {
  let level: 0 | Level = 0;
  for (const candidate of [1, 2, 3] as const) {
    if (candidate > requested) break;
    const atLevel = checks.filter((check) => check.level === candidate);
    if (atLevel.length === 0 || atLevel.some((check) => !check.ok)) break;
    level = candidate;
  }
  return level;
};

/**
 * Verify every package of the target (in one transaction, or all of them) to the
 * requested level. Never throws for a failed check; throws for invalid input or an
 * unreachable source.
 *
 * @throws {RangeError} On an invalid request (address, name, level, segment, a Level 3
 * request without the expected key).
 */
export const verifyPackages = async (
  source: VerifySource,
  request: VerifyRequest,
): Promise<VerifyReport> => {
  const { target, level } = request;
  if (![1, 2, 3].includes(level)) throw new RangeError("level must be 1, 2 or 3");
  if (!ADDRESS.test(target.contract)) {
    throw new RangeError("contract must be 64 lowercase hex characters");
  }
  if (target.entryPoint.length === 0) throw new RangeError("the entry point must not be empty");
  const name = eventName(target.name);
  if (request.segment !== undefined) {
    if (request.transactionHash === undefined)
      throw new RangeError("a segment needs a transaction");
    if (!Number.isInteger(request.segment) || request.segment < 1 || request.segment > 65535) {
      throw new RangeError("segment must be 1..65535");
    }
  }
  if (level >= 3 && request.expectedVerifierKey === undefined) {
    throw new RangeError("Level 3 needs the expected verifier key");
  }
  const limits = request.limits ?? DEFAULT_READER_LIMITS;
  const base = {
    source: source.description,
    mode: request.transactionHash === undefined ? ("listing" as const) : ("transaction" as const),
    network: target.network,
    contract: target.contract,
    name: eventNameText(name),
    nameHex: bytesToHex(name),
    entryPoint: target.entryPoint,
    requestedLevel: level,
    ...(request.transactionHash === undefined ? {} : { transactionHash: request.transactionHash }),
    ...(request.segment === undefined ? {} : { segment: request.segment }),
    ...(request.expectedVerifierKey === undefined || level < 3
      ? {}
      : { expectedVerifierKeySha256: verifierKeySha256(request.expectedVerifierKey) }),
  };
  const notFound = (note: string, events = 0, otherEvents = 0): VerifyReport => ({
    ...base,
    level: 0,
    notFound: true,
    events,
    otherEvents,
    packages: [],
    notes: [note],
  });

  const transactions = new Map<string, SourceTransaction | undefined>();
  const fetchTransaction = async (hash: string): Promise<SourceTransaction | undefined> => {
    if (!transactions.has(hash)) transactions.set(hash, await source.transaction(hash));
    return transactions.get(hash);
  };
  if (request.transactionHash !== undefined) {
    if ((await fetchTransaction(request.transactionHash)) === undefined) {
      return notFound(
        `transaction ${request.transactionHash} is not known to the source (not indexed yet, or a wrong hash)`,
      );
    }
  }

  // Level 1 input: the contract's events (of the transaction), grouped into packages.
  const fetched = await source.events(target.contract, request.transactionHash);
  const read = readPackages(fetched.events, {
    optIns: [{ contract: target.contract, name }],
    network: target.network,
    limits,
  });
  const inScope = (pkg: Package): boolean =>
    request.segment === undefined || pkg.segment === request.segment;
  const entries = new Map<string, Entry>();
  for (const pkg of read.packages.filter(inScope)) {
    entries.set(entryKey(pkg.transactionHash, pkg.segment), {
      transactionHash: pkg.transactionHash,
      segment: pkg.segment,
      fromEvents: pkg,
    });
  }

  // Level 2 input: each transaction's raw bytes, and any package only they show.
  const facts = new Map<string, TransactionFacts>();
  if (level >= 2) {
    const hashes =
      request.transactionHash === undefined
        ? [...new Set([...entries.values()].map((entry) => entry.transactionHash))]
        : [request.transactionHash];
    for (const hash of hashes) {
      const transaction = await fetchTransaction(hash);
      if (transaction === undefined) {
        facts.set(hash, {
          checks: [{ level: 2, ok: false, message: "the source does not have the transaction" }],
        });
        continue;
      }
      let decoded: AnyTransaction;
      try {
        decoded = deserializeTransaction(transaction.raw);
      } catch {
        facts.set(hash, {
          transaction,
          checks: [
            { level: 2, ok: false, message: "the raw bytes are not a ledger-v9 transaction" },
          ],
        });
        continue;
      }
      const checks: Check[] = [];
      if (INCLUDED_STATUSES.includes(transaction.status)) {
        checks.push({ level: 2, ok: true, message: `included, status ${transaction.status}` });
      } else {
        checks.push({
          level: 2,
          ok: false,
          message: `status ${transaction.status || "(none)"} is not an inclusion (SUCCESS or PARTIAL_SUCCESS)`,
        });
      }
      const ownHash = transactionHashOf(decoded);
      if (ownHash === undefined) {
        checks.push({
          level: 2,
          ok: true,
          message:
            "the raw bytes carry no hash of their own (not proven and bound); the reported hash is used",
        });
      } else if (ownHash !== hash) {
        checks.push({
          level: 2,
          ok: false,
          message: `the raw bytes hash to ${ownHash}, not to the reported ${hash}`,
        });
      } else {
        checks.push({ level: 2, ok: true, message: "the raw bytes hash to the transaction" });
      }
      if (request.crossCheckNode === true) {
        if (source.nodeHolds === undefined) {
          checks.push({ level: 2, ok: false, message: "no node to cross-check against" });
        } else if (transaction.block === undefined) {
          checks.push({
            level: 2,
            ok: false,
            message: "the node cross-check needs the transaction's block",
          });
        } else {
          const index = await source.nodeHolds(transaction.block.hash, transaction.raw);
          checks.push(
            index === undefined
              ? {
                  level: 2,
                  ok: false,
                  message: `the node's block ${String(transaction.block.height)} (${transaction.block.hash}) does not hold these bytes`,
                }
              : {
                  level: 2,
                  ok: true,
                  message: `the node's block ${String(transaction.block.height)} holds the raw bytes (extrinsic ${String(index)})`,
                },
          );
        }
      }
      facts.set(hash, { transaction, decoded, checks });
      const fromRaw = readPackages(
        partEventsFromTransaction(decoded, {
          network: target.network,
          contract: target.contract,
          transactionHash: hash,
        }).events,
        { optIns: [{ contract: target.contract, name }], network: target.network, limits },
      );
      for (const pkg of fromRaw.packages.filter(inScope)) {
        const key = entryKey(hash, pkg.segment);
        if (!entries.has(key)) {
          entries.set(key, { transactionHash: hash, segment: pkg.segment, rawOnly: pkg });
        }
      }
    }
  }

  if (entries.size === 0) {
    const scope =
      request.transactionHash === undefined
        ? `among the contract's ${String(fetched.count)} Misc events`
        : `in transaction ${request.transactionHash}${request.segment === undefined ? "" : ` at segment ${String(request.segment)}`}`;
    return notFound(
      `no package of (${target.contract}, ${eventNameText(name)}) ${scope}`,
      fetched.count,
      read.ignored,
    );
  }

  // Per-package checks.
  const states = new Map<string, Uint8Array | undefined>();
  const stateAt = async (block: BlockRef | undefined): Promise<Uint8Array | undefined> => {
    const key = block?.hash ?? "";
    if (!states.has(key)) states.set(key, await source.contractState(target.contract, block));
    return states.get(key);
  };
  const packages: PackageReport[] = [];
  for (const entry of entries.values()) {
    const checks: Check[] = [];
    const pkg = entry.fromEvents;
    const conversion = fetched.issues.get(entry.transactionHash) ?? [];
    if (pkg === undefined) {
      checks.push({
        level: 1,
        ok: false,
        message: `the events lack this package: the raw transaction's intent logs ${String(entry.rawOnly?.parts.length ?? 0)} parts named N`,
      });
    } else if (pkg.status !== "accepted") {
      checks.push({ level: 1, ok: false, message: `rejected: ${pkg.issues.join("; ")}` });
    } else if (conversion.length > 0) {
      checks.push({
        level: 1,
        ok: false,
        message: `events of this transaction could not all be read (the package may be incomplete): ${conversion.join("; ")}`,
      });
    } else {
      checks.push({
        level: 1,
        ok: true,
        message: `${String(pkg.parts.length)} part(s), ${String(pkg.payload?.byteLength ?? 0)} bytes, payload SHA-256 ${sha256Hex(pkg.payload ?? new Uint8Array())}`,
      });
    }
    const fact = facts.get(entry.transactionHash);
    const block = fact?.transaction?.block ?? fetched.blocks.get(entry.transactionHash);
    if (level >= 2 && pkg !== undefined && checks.every((check) => check.ok)) {
      checks.push(...(fact?.checks ?? []));
      if (fact?.decoded !== undefined) {
        const placement = checkPlacement(fact.decoded, target, pkg);
        if (placement.length === 0) {
          checks.push({
            level: 2,
            ok: true,
            message: `every ${target.entryPoint} call in the intent at segment ${String(entry.segment)} is guaranteed-only and logs these ${String(pkg.parts.length)} part(s), in order`,
          });
        } else {
          for (const issue of placement) checks.push({ level: 2, ok: false, message: issue });
        }
      }
    }
    if (level >= 3 && request.expectedVerifierKey !== undefined && levelOf(checks, 2) === 2) {
      const where = block === undefined ? "" : ` at block ${String(block.height)}`;
      const state = await stateAt(block);
      if (state === undefined) {
        checks.push({
          level: 3,
          ok: false,
          message: `the source has no state of the contract${where}`,
        });
      } else {
        let comparison;
        try {
          comparison = compareDeployedVerifierKey(
            state,
            target.entryPoint,
            request.expectedVerifierKey,
          );
        } catch {
          comparison = undefined;
        }
        if (comparison === undefined) {
          checks.push({ level: 3, ok: false, message: "the contract state does not decode" });
        } else if (comparison.deployedSha256 === undefined) {
          checks.push({
            level: 3,
            ok: false,
            message: `the contract has no ${target.entryPoint} verifier key${where}`,
          });
        } else if (!comparison.ok) {
          checks.push({
            level: 3,
            ok: false,
            message: `the deployed ${target.entryPoint} verifier key${where} (SHA-256 ${comparison.deployedSha256}) differs from the expected one (SHA-256 ${comparison.expectedSha256})`,
          });
        } else {
          checks.push({
            level: 3,
            ok: true,
            message: `the deployed ${target.entryPoint} verifier key${where} equals the expected one (SHA-256 ${comparison.deployedSha256})`,
          });
        }
      }
    }
    const shown = pkg ?? entry.rawOnly;
    const payload = pkg?.status === "accepted" ? pkg.payload : undefined;
    packages.push({
      transactionHash: entry.transactionHash,
      segment: entry.segment,
      ...(block === undefined ? {} : { block }),
      ...(fact?.transaction === undefined ? {} : { status: fact.transaction.status }),
      parts: shown?.parts.length ?? 0,
      payloadBytes: payload?.byteLength ?? 0,
      ...(payload === undefined
        ? {}
        : { payloadSha256: sha256Hex(payload), payloadHex: bytesToHex(payload) }),
      level: levelOf(checks, level),
      checks,
    });
  }
  packages.sort(
    (left, right) =>
      (left.block?.height ?? Number.MAX_SAFE_INTEGER) -
        (right.block?.height ?? Number.MAX_SAFE_INTEGER) ||
      compareCodeUnits(left.transactionHash, right.transactionHash) ||
      left.segment - right.segment,
  );
  return {
    ...base,
    level: packages.reduce<0 | Level>(
      (lowest, pkg) => (pkg.level < lowest ? pkg.level : lowest),
      level,
    ),
    notFound: false,
    events: fetched.count,
    otherEvents: read.ignored,
    packages,
    notes: [],
  };
};

/** Human-readable lines for a report. */
export const reportLines = (report: VerifyReport): string[] => {
  const lines = [
    `source      ${report.source}`,
    `contract    ${report.contract} (network ${report.network})`,
    `event name  ${report.name}; emitting circuit ${report.entryPoint}`,
  ];
  if (report.transactionHash !== undefined) {
    lines.push(`transaction ${report.transactionHash}`);
  }
  if (report.expectedVerifierKeySha256 !== undefined) {
    lines.push(
      `expected ${report.entryPoint} verifier key SHA-256 ${report.expectedVerifierKeySha256}`,
    );
  }
  for (const pkg of report.packages) {
    const where = pkg.block === undefined ? "" : `, block ${String(pkg.block.height)}`;
    lines.push(
      `package     transaction ${pkg.transactionHash}, segment ${String(pkg.segment)}${where}`,
    );
    for (const check of pkg.checks) {
      lines.push(`  L${String(check.level)} ${check.ok ? "OK  " : "FAIL"} ${check.message}`);
    }
    lines.push(`  verified to level ${String(pkg.level)}`);
  }
  for (const note of report.notes) lines.push(report.notFound ? `not found: ${note}` : note);
  const count = report.packages.length;
  lines.push(
    `result      ${String(count)} package(s); verified to level ${String(report.level)} of ${String(report.requestedLevel)} — ${LEVEL_MEANING[report.level] ?? ""}`,
  );
  return lines;
};
