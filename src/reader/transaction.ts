/**
 * Packages from ledger data: ledger events, and raw transactions with the placement
 * check that verification Level 2 applies.
 *
 * - {@link partEventsFromLedgerEvents} turns ledger `contractLog` events (from
 *   `LedgerState.apply`, or indexer `raw` event bytes via `Event.deserialize`) into
 *   reader input, taking the intent from `EventSource.physicalSegment`.
 * - {@link partEventsFromTransaction} reads the same values from a raw transaction: every
 *   `Misc` value a contract's calls log, per intent, in ledger emission order.
 * - {@link checkPlacement} checks one package against the raw transaction: every call of
 *   the emitting circuit of that contract in that intent is guaranteed-only, and the
 *   package's parts equal what those calls log, in order. Other intents, including
 *   other intents that call the same contract, are ignored.
 * - {@link verifyTransactionPackages} reads the packages of a (contract, N) from a raw
 *   transaction and checks each one's placement and the inclusion status.
 *
 * These are structural checks on transaction bytes; they do not verify proofs. A
 * transaction included on chain (SUCCESS or PARTIAL_SUCCESS) was verified by the network.
 *
 * @module
 */
import * as ledger from "@midnightntwrk/ledger-v9";

import { bytesEqual, bytesToHex } from "./bytes.js";
import { EVENT_LENGTH, eventName, NAME_LENGTH } from "./event.js";
import {
  type Package,
  type PartEvent,
  readPackages,
  type ReaderLimits,
  type ReadOutput,
} from "./packages.js";

/** Any ledger-v9 transaction, whatever its signature/proof/binding stage. */
export type AnyTransaction = ledger.Transaction<
  ledger.Signaturish,
  ledger.Proofish,
  ledger.Bindingish
>;

/** Type code of a `Misc` event in a logged item `[version, type, data]`. */
export const MISC_EVENT_TYPE_CODE = 10;

type Op = ledger.Op<ledger.AlignedValue>;

/** An entry point as text (the ledger reports it as text or bytes). */
export const entryPointText = (entryPoint: Uint8Array | string): string =>
  typeof entryPoint === "string" ? entryPoint : new TextDecoder().decode(entryPoint);

const cellAtom = (value: ledger.EncodedStateValue, width?: number): Uint8Array => {
  if (value.tag !== "cell") throw new RangeError(`expected a cell, found '${value.tag}'`);
  const { alignment, value: atoms } = value.content;
  const [segment] = alignment;
  if (
    alignment.length !== 1 ||
    segment === undefined ||
    segment.tag !== "atom" ||
    segment.value.tag !== "bytes" ||
    (width !== undefined && segment.value.length !== width)
  ) {
    throw new RangeError("unexpected cell alignment");
  }
  const [atom] = atoms;
  if (atoms.length !== 1 || atom === undefined) {
    throw new RangeError(`cell holds ${String(atoms.length)} atoms`);
  }
  if (atom.byteLength > segment.value.length) throw new RangeError("cell atom exceeds its width");
  return atom;
};

const littleEndianNumber = (bytes: Uint8Array): number => {
  let value = 0;
  for (let index = bytes.byteLength - 1; index >= 0; index -= 1) {
    value = value * 256 + (bytes[index] ?? 0);
  }
  return value;
};

/**
 * Decode a logged `Misc` value (a `Bytes<288>` cell whose trailing zeros the ledger
 * trimmed) into its full 288 bytes.
 *
 * @throws {RangeError} If the value is not a single `bytes(288)` atom of at most 288 bytes.
 */
export const decodeMiscValue = (data: ledger.EncodedStateValue): Uint8Array => {
  const atom = cellAtom(data, EVENT_LENGTH);
  const full = new Uint8Array(EVENT_LENGTH);
  full.set(atom);
  return full;
};

/** One event a transcript program logs. */
export interface LoggedEvent {
  readonly typeCode: number;
  readonly data: ledger.EncodedStateValue;
}

/**
 * Every event a transcript program logs, in order: each `log` op's operand is the
 * immediately preceding non-storage `push` of `[version, type, data]`.
 *
 * @throws {RangeError} If a `log` op does not have that shape.
 */
export const loggedEvents = (program: readonly Op[]): LoggedEvent[] =>
  program.flatMap((op, index) => {
    if (op !== "log") return [];
    const push = program[index - 1];
    if (push === undefined || typeof push === "string" || !("push" in push)) {
      throw new RangeError("log operand is not a pushed value");
    }
    if (push.push.storage) throw new RangeError("log operand is a storage value");
    const item = push.push.value;
    if (item.tag !== "array" || item.content.length !== 3) {
      throw new RangeError("logged item is not [version, type, data]");
    }
    const [, type, data] = item.content;
    if (type === undefined || data === undefined) throw new RangeError("logged item is incomplete");
    return [{ typeCode: littleEndianNumber(cellAtom(type)), data }];
  });

/** A `Misc` value one call logs, as found in a raw transaction. */
export interface LoggedPart {
  readonly segment: number;
  readonly actionIndex: number;
  readonly entryPoint: string;
  /** Which transcript logs it. */
  readonly transcript: "guaranteed" | "fallible";
  /** Width-restored value: 32-byte name then 256-byte payload. */
  readonly value: Uint8Array;
}

/** One call to the contract in a raw transaction. */
export interface ContractCallSummary {
  readonly segment: number;
  readonly actionIndex: number;
  readonly entryPoint: string;
  readonly guaranteed: boolean;
  readonly fallible: boolean;
}

/** Every call to one contract in a transaction, and every `Misc` value they log. */
export interface ContractActivity {
  readonly calls: readonly ContractCallSummary[];
  /**
   * Logged `Misc` values per intent in ledger emission order: in ascending segment
   * order; inside an intent, every guaranteed transcript's values in call order, then
   * every fallible transcript's values in call order.
   */
  readonly parts: readonly LoggedPart[];
  /** Transcripts that could not be read. */
  readonly issues: readonly string[];
}

/** Intents in ascending segment order. */
const orderedIntents = (tx: AnyTransaction) =>
  [
    ...(tx.intents ??
      new Map<number, ledger.Intent<ledger.Signaturish, ledger.Proofish, ledger.Bindingish>>()),
  ].sort(([left], [right]) => left - right);

/**
 * Every call to `contract` in a transaction and every `Misc` value those calls log.
 *
 * @param tx - A deserialized transaction (any stage).
 * @param contract - Contract address (lowercase hex).
 */
export const contractActivity = (tx: AnyTransaction, contract: string): ContractActivity => {
  const calls: ContractCallSummary[] = [];
  const parts: LoggedPart[] = [];
  const issues: string[] = [];
  for (const [segment, intent] of orderedIntents(tx)) {
    const fallibleParts: LoggedPart[] = [];
    intent.actions.forEach((action, actionIndex) => {
      if (!(action instanceof ledger.ContractCall) || action.address !== contract) return;
      const entryPoint = entryPointText(action.entryPoint);
      calls.push({
        segment,
        actionIndex,
        entryPoint,
        guaranteed: action.guaranteedTranscript !== undefined,
        fallible: action.fallibleTranscript !== undefined,
      });
      const read = (
        transcript: ledger.Transcript<ledger.AlignedValue> | undefined,
        kind: LoggedPart["transcript"],
        into: LoggedPart[],
      ) => {
        if (transcript === undefined) return;
        try {
          for (const event of loggedEvents(transcript.program)) {
            if (event.typeCode !== MISC_EVENT_TYPE_CODE) continue;
            into.push({
              segment,
              actionIndex,
              entryPoint,
              transcript: kind,
              value: decodeMiscValue(event.data),
            });
          }
        } catch (error) {
          if (!(error instanceof RangeError)) throw error;
          issues.push(
            `segment ${String(segment)} call ${String(actionIndex)} (${entryPoint}) ${kind} transcript: ${error.message}`,
          );
        }
      };
      read(action.guaranteedTranscript, "guaranteed", parts);
      read(action.fallibleTranscript, "fallible", fallibleParts);
    });
    parts.push(...fallibleParts);
  }
  return { calls, parts, issues };
};

/** Scope of reader input built from a raw transaction. */
export interface TransactionScope {
  readonly network: string;
  readonly contract: string;
  readonly transactionHash: string;
}

/**
 * Reader input from a raw transaction: every `Misc` value the contract's calls log,
 * with the intent's segment and a position that follows ledger emission order inside
 * the intent.
 */
export const partEventsFromTransaction = (
  tx: AnyTransaction,
  scope: TransactionScope,
): { readonly events: PartEvent[]; readonly issues: readonly string[] } => {
  const activity = contractActivity(tx, scope.contract);
  const next = new Map<number, number>();
  const events = activity.parts.map((part) => {
    const position = next.get(part.segment) ?? 0;
    next.set(part.segment, position + 1);
    return {
      network: scope.network,
      contract: scope.contract,
      transactionHash: scope.transactionHash,
      segment: part.segment,
      position,
      value: part.value,
    };
  });
  return { events, issues: activity.issues };
};

/** Options for {@link partEventsFromLedgerEvents}. */
export interface LedgerEventOptions {
  readonly network: string;
  /** Only convert events of these contracts (default: every contract). */
  readonly contracts?: readonly string[];
  /**
   * Position of an event in ledger emission order. Default: its index in the list,
   * which is emission order for `LedgerState.apply` results. For indexer events pass
   * the indexer's event id.
   */
  readonly positionOf?: (event: ledger.Event, index: number) => number;
}

/**
 * Turn ledger `contractLog` events of type `misc` into reader input. Other events are
 * skipped; a `misc` event whose value is not a `Bytes<288>` cell is reported.
 */
export const partEventsFromLedgerEvents = (
  events: readonly ledger.Event[],
  options: LedgerEventOptions,
): { readonly events: PartEvent[]; readonly issues: string[] } => {
  const out: PartEvent[] = [];
  const issues: string[] = [];
  events.forEach((event, index) => {
    const content = event.content;
    if (content.tag !== "contractLog") return;
    const log = content as Extract<ledger.EventDetails, { tag: "contractLog" }>;
    if (options.contracts !== undefined && !options.contracts.includes(log.address)) return;
    if (log.loggedItem.eventType !== "misc") return;
    const position = options.positionOf?.(event, index) ?? index;
    let value: Uint8Array;
    try {
      value = decodeMiscValue(log.loggedItem.data);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      issues.push(`event at position ${String(position)}: ${error.message}`);
      return;
    }
    out.push({
      network: options.network,
      contract: log.address,
      transactionHash: String(event.source.transactionHash),
      segment: event.source.physicalSegment,
      position,
      value,
    });
  });
  return { events: out, issues };
};

/** What verification checks placement against. */
export interface PlacementTarget {
  /** Contract address (lowercase hex). */
  readonly contract: string;
  /** The emitting circuit (entry point), e.g. `emitPart`. */
  readonly entryPoint: string;
  /** The event name N. */
  readonly name: string | Uint8Array;
}

/**
 * Check one package's placement against the raw transaction that holds it: an intent
 * exists at the package's segment; every call of the emitting circuit of the contract
 * in that intent is guaranteed-only; no other circuit of the contract logs N there; and
 * the `Misc` values named N those calls log, in call order, equal the package's parts.
 * Other intents are ignored.
 *
 * @returns The problems found; empty when the placement holds.
 */
export const checkPlacement = (
  tx: AnyTransaction,
  target: PlacementTarget,
  pkg: Pick<Package, "segment" | "parts">,
): string[] => {
  const name = eventName(target.name);
  const issues: string[] = [];
  if (tx.intents?.get(pkg.segment) === undefined) {
    return [`no intent at segment ${String(pkg.segment)}`];
  }
  const activity = contractActivity(tx, target.contract);
  issues.push(
    ...activity.issues.filter((issue) => issue.startsWith(`segment ${String(pkg.segment)} `)),
  );
  const calls = activity.calls.filter((call) => call.segment === pkg.segment);
  const emitting = calls.filter((call) => call.entryPoint === target.entryPoint);
  for (const call of emitting) {
    if (call.fallible || !call.guaranteed) {
      issues.push(
        `call ${String(call.actionIndex)} of ${target.entryPoint} is not guaranteed-only (${call.fallible ? "fallible transcript" : "no guaranteed transcript"})`,
      );
    }
  }
  const named = activity.parts.filter(
    (part) => part.segment === pkg.segment && bytesEqual(part.value.subarray(0, NAME_LENGTH), name),
  );
  for (const part of named) {
    if (part.entryPoint !== target.entryPoint) {
      issues.push(`call ${String(part.actionIndex)} (${part.entryPoint}) also logs the name`);
    }
  }
  const expected = named
    .filter((part) => part.entryPoint === target.entryPoint && part.transcript === "guaranteed")
    .map((part) => part.value.slice(NAME_LENGTH));
  if (expected.length !== pkg.parts.length) {
    issues.push(
      `the intent's ${target.entryPoint} calls log ${String(expected.length)} parts; the package has ${String(pkg.parts.length)}`,
    );
  } else {
    expected.forEach((payload, index) => {
      const part = pkg.parts[index];
      if (part === undefined || !bytesEqual(payload, part)) {
        issues.push(`part ${String(index + 1)} differs from what call ${String(index + 1)} logs`);
      }
    });
  }
  return issues;
};

/** Indexer `RegularTransaction.transactionResult.status` values accepted as inclusion. */
export const INCLUDED_STATUSES: readonly string[] = Object.freeze(["SUCCESS", "PARTIAL_SUCCESS"]);

/** Map a local ledger `TransactionResult.type` to the indexer status names. */
export const statusFromLedgerResult = (type: "success" | "partialSuccess" | "failure"): string =>
  type === "success" ? "SUCCESS" : type === "partialSuccess" ? "PARTIAL_SUCCESS" : "FAILURE";

const DESERIALIZE_MARKERS = [
  ["signature", "proof", "binding"],
  ["signature", "no-proof", "no-binding"],
  ["signature", "proof", "pre-binding"],
  ["signature", "pre-proof", "pre-binding"],
  ["signature", "pre-proof", "binding"],
] as const;

/**
 * Deserialize raw transaction bytes: finalized first, then erased, unbound, unproven,
 * and unproven-but-bound forms.
 *
 * @throws {Error} If no form matches.
 */
export const deserializeTransaction = (raw: Uint8Array): AnyTransaction => {
  for (const [signature, proof, binding] of DESERIALIZE_MARKERS) {
    try {
      return ledger.Transaction.deserialize(signature, proof, binding, raw);
    } catch {
      // try the next form
    }
  }
  throw new Error("bytes are not a ledger-v9 transaction");
};

/**
 * The ledger transaction hash, or `undefined` for transactions that are not proven,
 * signed and bound (ledger-v9 computes the hash only for those).
 */
export const transactionHashOf = (tx: AnyTransaction): string | undefined => {
  try {
    return tx.transactionHash();
  } catch {
    return undefined;
  }
};

/** Options for {@link verifyTransactionPackages}. */
export interface VerifyTransactionOptions extends PlacementTarget {
  /** Network the chain source belongs to (the JS ledger API has no network getter). */
  readonly network: string;
  /** Inclusion status reported by the chain source. */
  readonly status: string;
  /**
   * Transaction hash reported by the chain source. It must equal the bytes' hash; it is
   * also the package scope when the bytes carry no hash (unproven test transactions).
   */
  readonly transactionHash?: string;
  readonly limits?: ReaderLimits;
}

/** A package read from the raw transaction, with its placement problems. */
export interface CheckedPackage {
  readonly package: Package;
  /** Placement problems; empty when the placement holds. */
  readonly placement: readonly string[];
}

/** Outcome of {@link verifyTransactionPackages}. */
export interface TransactionVerification {
  readonly transactionHash: string;
  readonly status: string;
  /** Transaction-level problems (inclusion status, hash); any one fails every package. */
  readonly issues: readonly string[];
  readonly read: ReadOutput;
  /** Every package of the (contract, N) in the transaction, one per intent. */
  readonly packages: readonly CheckedPackage[];
  /** Packages that are accepted with a clean placement, when there is no transaction-level problem. */
  readonly verified: readonly Package[];
}

/**
 * Read every package of a (contract, N) from a raw transaction and check each one's
 * placement, plus the transaction's inclusion status and hash.
 *
 * @param input - Deserialized transaction or its raw bytes.
 */
export const verifyTransactionPackages = (
  input: AnyTransaction | Uint8Array,
  options: VerifyTransactionOptions,
): TransactionVerification => {
  const tx = input instanceof Uint8Array ? deserializeTransaction(input) : input;
  const issues: string[] = [];
  const ownHash = transactionHashOf(tx);
  const transactionHash = ownHash ?? options.transactionHash ?? "";
  if (transactionHash.length === 0) {
    issues.push("no transaction hash: the bytes are not proven and bound, and none was reported");
  }
  if (
    ownHash !== undefined &&
    options.transactionHash !== undefined &&
    options.transactionHash !== ownHash
  ) {
    issues.push("reported transaction hash differs from the bytes' hash");
  }
  if (!INCLUDED_STATUSES.includes(options.status)) {
    issues.push(`status ${options.status} is not an inclusion (SUCCESS or PARTIAL_SUCCESS)`);
  }
  const extracted = partEventsFromTransaction(tx, {
    network: options.network,
    contract: options.contract,
    transactionHash: transactionHash.length === 0 ? "unknown" : transactionHash,
  });
  const read = readPackages(extracted.events, {
    optIns: [{ contract: options.contract, name: options.name }],
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
  const packages = read.packages.map((pkg) => ({
    package: pkg,
    placement: checkPlacement(tx, options, pkg),
  }));
  const verified =
    issues.length === 0
      ? packages
          .filter((entry) => entry.package.status === "accepted" && entry.placement.length === 0)
          .map((entry) => entry.package)
      : [];
  return { transactionHash, status: options.status, issues, read, packages, verified };
};

/** Hex of a package's merged payload, for reports. */
export const payloadHex = (pkg: Package): string => bytesToHex(pkg.payload ?? new Uint8Array());
