/**
 * Raw-transaction extraction and wallet-free verification.
 *
 * Fragments are taken from the transaction itself: for each call to the expected
 * emitter's emission entry point, the logged `Misc` value is read from the call's
 * transcript program, its 288-byte width restored, and its placement checked (a part
 * must come from a guaranteed transcript, with no fallible transcript). Calls to other
 * contracts and other entry points are ignored, so intents merged in by third parties
 * do not change the result. No publisher-produced guard data is needed.
 *
 * These are structural and placement checks on transaction bytes; they do not verify
 * proofs, and nothing here claims to. Proof validity is outside this profile: a
 * transaction included on chain (status SUCCESS or PARTIAL_SUCCESS from the chain
 * source) was verified by the network, and what the message means is the emitting
 * contract's business.
 *
 * @module
 */
import * as ledger from "@midnightntwrk/ledger-v9";

import { bytesToHex } from "./bytes.js";
import { EVENT_LENGTH, NAME_LENGTH, type ReaderLimits } from "./constants.js";
import {
  type PublicEvent,
  type ReadOutput,
  readPublications,
  type ReadResult,
  ReadStatus,
} from "./reader.js";

/** Any ledger-v9 transaction, whatever its signature/proof/binding stage. */
export type AnyTransaction = ledger.Transaction<
  ledger.Signaturish,
  ledger.Proofish,
  ledger.Bindingish
>;

/** The contract and circuit whose calls carry publication parts. */
export interface EmissionTarget {
  /** Emitter contract address (lowercase hex as the ledger reports it). */
  readonly emitter: string;
  /** Emission entry point, e.g. `emitPart`. */
  readonly entryPoint: string;
}

/** One emission call found in a transaction. */
export interface ExtractedEmission {
  /** Physical segment (intent) of the call. */
  readonly segment: number;
  /** Index of the call among its intent's actions. */
  readonly actionIndex: number;
  /** Raw call position `segment:actionIndex`, used as the event identity. */
  readonly eventId: string;
  /** Width-restored name (32 bytes). */
  readonly name: Uint8Array;
  /** Width-restored payload (256 bytes). */
  readonly payload: Uint8Array;
  /** Placement or event-shape defects; any defect rejects the part's group. */
  readonly issues: readonly string[];
}

/** Extraction result. */
export interface Extraction {
  readonly emissions: readonly ExtractedEmission[];
  /** Defects that cannot be attributed to one group (they block every acceptance). */
  readonly transactionIssues: readonly string[];
}

/** Type code of a `Misc` event in a logged item `[version, type, data]`. */
const MISC_EVENT_TYPE_CODE = 10;

type Op = ledger.Op<ledger.AlignedValue>;

const entryPointText = (entryPoint: Uint8Array | string): string =>
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

/** The single event a transcript program logs. */
interface LoggedEvent {
  readonly typeCode: number;
  readonly data: ledger.EncodedStateValue;
}

/**
 * Find the one event a call's transcript logs: exactly one `log` op, whose operand is
 * the immediately preceding non-storage `push` of `[version, type, data]`.
 *
 * @throws {RangeError} If the program does not have that shape.
 */
export const loggedEvent = (program: readonly Op[]): LoggedEvent => {
  const logIndexes = program.flatMap((op, index) => (op === "log" ? [index] : []));
  if (logIndexes.length !== 1) {
    throw new RangeError(`transcript logs ${String(logIndexes.length)} events, expected 1`);
  }
  const push = program[(logIndexes[0] ?? 0) - 1];
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
  return { typeCode: littleEndianNumber(cellAtom(type)), data };
};

/** Intents in ascending segment order. */
const orderedIntents = (tx: AnyTransaction) =>
  [
    ...(tx.intents ??
      new Map<number, ledger.Intent<ledger.Signaturish, ledger.Proofish, ledger.Bindingish>>()),
  ].sort(([left], [right]) => left - right);

/**
 * Extract every emission call to the target from a transaction.
 *
 * @param tx - A deserialized transaction (any stage).
 * @param target - Expected emitter and entry point.
 */
export const extractEmissions = (tx: AnyTransaction, target: EmissionTarget): Extraction => {
  const emissions: ExtractedEmission[] = [];
  const transactionIssues: string[] = [];
  for (const [segment, intent] of orderedIntents(tx)) {
    intent.actions.forEach((action, actionIndex) => {
      const eventId = `${String(segment)}:${String(actionIndex)}`;
      if (!(action instanceof ledger.ContractCall) || action.address !== target.emitter) return;
      if (entryPointText(action.entryPoint) !== target.entryPoint) return;
      const guaranteed = action.guaranteedTranscript;
      const fallible = action.fallibleTranscript;
      if (guaranteed === undefined && fallible === undefined) {
        transactionIssues.push(`call ${eventId}: emission call without transcripts`);
        return;
      }
      const issues: string[] = [];
      if (fallible !== undefined) issues.push("part is placed in a fallible transcript");
      const hasLog = (transcript: ledger.Transcript<ledger.AlignedValue> | undefined): boolean =>
        transcript?.program.some((op) => op === "log") ?? false;
      const source = hasLog(guaranteed) ? guaranteed : fallible;
      let value: Uint8Array;
      try {
        const event = loggedEvent(source?.program ?? []);
        if (event.typeCode !== MISC_EVENT_TYPE_CODE) {
          throw new RangeError(`logged event type code ${String(event.typeCode)} is not Misc`);
        }
        value = decodeMiscValue(event.data);
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        transactionIssues.push(`call ${eventId}: ${error.message}`);
        return;
      }
      emissions.push({
        segment,
        actionIndex,
        eventId,
        name: value.slice(0, NAME_LENGTH),
        payload: value.slice(NAME_LENGTH),
        issues,
      });
    });
  }
  return { emissions, transactionIssues };
};

/** Indexer `RegularTransaction.transactionResult.status` values accepted as inclusion. */
export const INCLUDED_STATUSES: readonly string[] = Object.freeze(["SUCCESS", "PARTIAL_SUCCESS"]);

/** Map a local ledger `TransactionResult.type` to the indexer status names. */
export const statusFromLedgerResult = (type: "success" | "partialSuccess" | "failure"): string =>
  type === "success" ? "SUCCESS" : type === "partialSuccess" ? "PARTIAL_SUCCESS" : "FAILURE";

/** Options for {@link verifyPublicationTransaction}. */
export interface VerifyOptions extends EmissionTarget {
  /** Network the chain source belongs to (the JS ledger API has no network getter). */
  readonly network: string;
  /** Inclusion status reported by the chain source. */
  readonly status: string;
  /**
   * Transaction hash reported by the chain source. It must equal the bytes' hash; it
   * is also the grouping scope when the bytes carry no hash (erased test transactions).
   */
  readonly transactionHash?: string;
  readonly limits?: ReaderLimits;
}

/** Verification outcome. */
export interface VerificationReport {
  readonly transactionHash: string;
  readonly status: string;
  readonly emissions: readonly ExtractedEmission[];
  readonly read: ReadOutput;
  /** Transaction-level problems; any one blocks acceptance. */
  readonly issues: readonly string[];
  /** Complete publications, or none when the status or a transaction-level check fails. */
  readonly accepted: readonly ReadResult[];
}

const DESERIALIZE_MARKERS = [
  ["signature", "proof", "binding"],
  ["signature", "no-proof", "no-binding"],
  ["signature", "proof", "pre-binding"],
  ["signature", "pre-proof", "pre-binding"],
  ["signature", "pre-proof", "binding"],
] as const;

/**
 * Deserialize raw transaction bytes: finalized first, then erased, unbound,
 * unproven, and unproven-but-bound forms.
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

/**
 * Verify one included transaction without wallet or publisher data: extract the
 * target's emissions, check placement and feed them to the strict reader.
 *
 * @param input - Deserialized transaction or its raw bytes.
 * @param options - Expected emitter, entry point, network and the chain's status/hash.
 */
export const verifyPublicationTransaction = (
  input: AnyTransaction | Uint8Array,
  options: VerifyOptions,
): VerificationReport => {
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
  const extraction = extractEmissions(tx, options);
  issues.push(...extraction.transactionIssues);
  const events: PublicEvent[] = extraction.emissions.map((emission) => ({
    network: options.network,
    emitter: options.emitter,
    transactionId: transactionHash,
    eventId: emission.eventId,
    name: emission.name,
    payload: emission.payload,
    ...(emission.issues.length === 0 ? {} : { sourceIssue: emission.issues.join("; ") }),
  }));
  const read = readPublications(
    events,
    options.limits === undefined ? {} : { limits: options.limits },
  );
  const accepted =
    issues.length === 0
      ? read.results.filter((result) => result.status === ReadStatus.Complete)
      : [];
  return {
    transactionHash,
    status: options.status,
    emissions: extraction.emissions,
    read,
    issues,
    accepted,
  };
};

/** Options for {@link publicEventsFromLedgerEvents}. */
export interface LedgerEventOptions extends EmissionTarget {
  readonly network: string;
  /** Identity of an event; defaults to `<transaction hash>/<index in the list>`. */
  readonly eventIdOf?: (event: ledger.Event, index: number) => string;
}

/**
 * Turn ledger `contractLog` events (from `LedgerState.apply`, or indexer `raw` event
 * bytes via `Event.deserialize`) into reader input. Only events of the target
 * emitter and entry point are kept; each must be a `misc` event whose value is a
 * `Bytes<288>` cell, otherwise it is reported. Events carry no placement
 * information (`logicalSegment` is 0 for fallible logs too), so placement must be
 * checked from the raw transaction.
 */
export const publicEventsFromLedgerEvents = (
  events: readonly ledger.Event[],
  options: LedgerEventOptions,
): { readonly events: PublicEvent[]; readonly issues: string[] } => {
  const out: PublicEvent[] = [];
  const issues: string[] = [];
  events.forEach((event, index) => {
    const content = event.content;
    if (content.tag !== "contractLog") return;
    const log = content as Extract<ledger.EventDetails, { tag: "contractLog" }>;
    if (log.address !== options.emitter || entryPointText(log.entryPoint) !== options.entryPoint)
      return;
    const eventId =
      options.eventIdOf?.(event, index) ?? `${event.source.transactionHash}/${String(index)}`;
    if (log.loggedItem.eventType !== "misc") {
      issues.push(`event ${eventId}: event type ${log.loggedItem.eventType} is not misc`);
      return;
    }
    let value: Uint8Array;
    try {
      value = decodeMiscValue(log.loggedItem.data);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      issues.push(`event ${eventId}: ${error.message}`);
      return;
    }
    out.push({
      network: options.network,
      emitter: log.address,
      transactionId: event.source.transactionHash,
      eventId,
      name: value.slice(0, NAME_LENGTH),
      payload: value.slice(NAME_LENGTH),
    });
  });
  return { events: out, issues };
};

/** Hex rendering helper for reports. */
export const emissionHex = (emission: ExtractedEmission): { name: string; payload: string } => ({
  name: bytesToHex(emission.name),
  payload: bytesToHex(emission.payload),
});
