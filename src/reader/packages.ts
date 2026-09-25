/**
 * The reader of the multi-part rule: packages from events.
 *
 * A protocol opts an event name N into the rule for its contracts. For every configured
 * (contract, N) pair the reader:
 *
 * 1. takes only `Misc` events of that contract whose name is exactly N (after restoring
 *    the 32-byte name and the 256-byte payload the ledger trims); every other event is
 *    left untouched;
 * 2. groups them by (network, contract, N, transaction, physical segment): one group is
 *    one package, the events one contract emitted from one intent;
 * 3. orders each group by the events' position (the raw action index, or an event id
 *    that follows ledger emission order), never by delivery order;
 * 4. tolerates an identical redelivery of one identity (same group and position) and
 *    rejects the package when one identity arrives with two contents;
 * 5. returns each package's merged payload: the concatenation of its 256-byte payloads.
 *
 * It never interprets the merged payload: that is the adopting protocol's processing.
 * It cannot tell whether it saw every event of an intent: a paging source must fetch
 * all of them first, and the placement check against the raw transaction detects a
 * missing part.
 *
 * @module
 */
import { bytesEqual, bytesToHex, compareCodeUnits } from "./bytes.js";
import { EVENT_LENGTH, eventName, eventNameText, NAME_LENGTH, restoreEventValue } from "./event.js";

/** A (contract, N) pair whose protocol declared that N follows the multi-part rule. */
export interface OptIn {
  /** Contract address: 64 lowercase hex characters. */
  readonly contract: string;
  /** The event name N: its text (padded to 32 bytes like Compact's `pad`) or its 32 bytes. */
  readonly name: string | Uint8Array;
}

/** One `Misc` event as a source delivers it. */
export interface PartEvent {
  /** Network the source belongs to. */
  readonly network: string;
  /** Emitting contract address (lowercase hex, as the ledger reports it). */
  readonly contract: string;
  /** Hash of the transaction that holds the event. */
  readonly transactionHash: string;
  /**
   * Physical segment: the intent of the call that emitted the event (the event's
   * `EventSource.physicalSegment`, or the intent's key in the raw transaction), 1..65535.
   */
  readonly segment: number;
  /**
   * Position in ledger emission order: the part's index among its intent's calls (raw
   * transaction), or an event id that follows ledger emission order (indexer event ids,
   * the index in `LedgerState.apply` results). Use one scheme per call. Together with
   * the group it is the event's identity.
   */
  readonly position: number;
  /** The logged value as stored: name then payload, at most 288 bytes; trailing zeros may be trimmed. */
  readonly value: Uint8Array;
}

/** Input bounds for one reader call. */
export interface ReaderLimits {
  /** Largest number of events accepted in one call. */
  readonly maxEvents: number;
  /** Largest number of distinct packages accepted in one call. */
  readonly maxPackages: number;
}

/** Default bounds: enough for several full pages (500 events each) of one contract. */
export const DEFAULT_READER_LIMITS: Readonly<ReaderLimits> = Object.freeze({
  maxEvents: 4096,
  maxPackages: 1024,
});

/** Options for {@link readPackages}. */
export interface ReadOptions {
  /** The opted-in (contract, N) pairs; events of any other pair are ignored. */
  readonly optIns: readonly OptIn[];
  /** Only read events of this network; others are ignored. */
  readonly network?: string;
  readonly limits?: ReaderLimits;
}

/** One package: every event named N one contract emitted from one intent. */
export interface Package {
  readonly network: string;
  readonly contract: string;
  /** N as 32 bytes. */
  readonly name: Uint8Array;
  /** N in readable form. */
  readonly nameText: string;
  readonly transactionHash: string;
  /** Physical segment of the intent. */
  readonly segment: number;
  /** `accepted`, or `rejected` when an identity arrived with two contents or a value was malformed. */
  readonly status: "accepted" | "rejected";
  /** Positions of the parts, ascending (distinct identities). */
  readonly positions: readonly number[];
  /** Width-restored 256-byte payloads, in position order. */
  readonly parts: readonly Uint8Array[];
  /** Concatenation of `parts`: what the adopting protocol processes. Accepted packages only. */
  readonly payload?: Uint8Array;
  /** Deliveries seen, redeliveries included. */
  readonly deliveries: number;
  /** Why the package was rejected (sorted); empty when accepted. */
  readonly issues: readonly string[];
}

/** Output of {@link readPackages}. */
export interface ReadOutput {
  /** Packages sorted by network, contract, name, transaction hash, then segment. */
  readonly packages: readonly Package[];
  /** Events of other contracts, names or networks, left untouched. */
  readonly ignored: number;
}

const ADDRESS = /^[0-9a-f]{64}$/;

/**
 * Validate reader limits.
 *
 * @throws {RangeError} If a limit is not a positive safe integer.
 */
export const validateReaderLimits = (limits: ReaderLimits): void => {
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || (value as number) < 1) {
      throw new RangeError(`${key} must be a positive safe integer`);
    }
  }
};

interface Delivery {
  readonly position: number;
  readonly value: Uint8Array | undefined;
  readonly malformed?: string;
}

interface Group {
  readonly network: string;
  readonly contract: string;
  readonly name: Uint8Array;
  readonly transactionHash: string;
  readonly segment: number;
  readonly deliveries: Delivery[];
}

const groupKey = (
  group: Pick<Group, "network" | "contract" | "name" | "transactionHash" | "segment">,
): string =>
  JSON.stringify([
    group.network,
    group.contract,
    bytesToHex(group.name),
    group.transactionHash,
    group.segment,
  ]);

const checkEvent = (event: PartEvent, index: number): void => {
  const where = `event ${String(index)}`;
  if (event.network.length === 0 || event.transactionHash.length === 0) {
    throw new RangeError(`${where}: empty network or transaction hash`);
  }
  if (!Number.isInteger(event.segment) || event.segment < 1 || event.segment > 65535) {
    throw new RangeError(`${where}: segment ${String(event.segment)} is not in 1..65535`);
  }
  if (!Number.isSafeInteger(event.position) || event.position < 0) {
    throw new RangeError(`${where}: position must be a non-negative safe integer`);
  }
};

const evaluate = (group: Group): Package => {
  const issues = new Set<string>();
  const byPosition = new Map<number, Uint8Array>();
  for (const delivery of group.deliveries) {
    if (delivery.malformed !== undefined || delivery.value === undefined) {
      issues.add(`position ${String(delivery.position)}: ${delivery.malformed ?? "malformed"}`);
      continue;
    }
    const seen = byPosition.get(delivery.position);
    if (seen === undefined) byPosition.set(delivery.position, delivery.value);
    else if (!bytesEqual(seen, delivery.value)) {
      issues.add(`position ${String(delivery.position)} was delivered with two contents`);
    }
  }
  const positions = [...byPosition.keys()].sort((left, right) => left - right);
  const parts = positions.map((position) =>
    (byPosition.get(position) ?? new Uint8Array(EVENT_LENGTH)).slice(NAME_LENGTH),
  );
  const common = {
    network: group.network,
    contract: group.contract,
    name: group.name,
    nameText: eventNameText(group.name),
    transactionHash: group.transactionHash,
    segment: group.segment,
    positions,
    parts,
    deliveries: group.deliveries.length,
  };
  if (issues.size > 0) {
    return {
      ...common,
      status: "rejected",
      issues: [...issues].sort(compareCodeUnits),
    };
  }
  const payload = new Uint8Array(parts.length * (EVENT_LENGTH - NAME_LENGTH));
  parts.forEach((part, index) => payload.set(part, index * part.byteLength));
  return { ...common, status: "accepted", payload, issues: [] };
};

/**
 * Read packages from events.
 *
 * @param events - Events in any order, from any number of pages, reconnects or sources.
 * @param options - The opted-in (contract, N) pairs, an optional network and bounds.
 * @throws {RangeError} On invalid options, events with invalid source fields (empty
 * network or hash, segment outside 1..65535, negative position), or input beyond the
 * bounds.
 */
export const readPackages = (events: readonly PartEvent[], options: ReadOptions): ReadOutput => {
  const limits = options.limits ?? DEFAULT_READER_LIMITS;
  validateReaderLimits(limits);
  if (options.optIns.length === 0) throw new RangeError("configure at least one (contract, N)");
  const names = new Map<string, Uint8Array[]>();
  for (const optIn of options.optIns) {
    if (!ADDRESS.test(optIn.contract)) {
      throw new RangeError(`opt-in contract '${optIn.contract}' is not 64 lowercase hex`);
    }
    const list = names.get(optIn.contract) ?? [];
    list.push(eventName(optIn.name));
    names.set(optIn.contract, list);
  }
  if (events.length > limits.maxEvents) {
    throw new RangeError(
      `event count ${String(events.length)} exceeds maxEvents ${String(limits.maxEvents)}`,
    );
  }

  const groups = new Map<string, Group>();
  let ignored = 0;
  events.forEach((event, index) => {
    checkEvent(event, index);
    const candidates = names.get(event.contract);
    if (
      candidates === undefined ||
      (options.network !== undefined && event.network !== options.network)
    ) {
      ignored += 1;
      return;
    }
    // The first 32 bytes decide the name, even for an over-long (malformed) value.
    const head = new Uint8Array(NAME_LENGTH);
    head.set(event.value.subarray(0, NAME_LENGTH));
    const name = candidates.find((candidate) => bytesEqual(candidate, head));
    if (name === undefined) {
      ignored += 1;
      return;
    }
    const scope = {
      network: event.network,
      contract: event.contract,
      name,
      transactionHash: event.transactionHash,
      segment: event.segment,
    };
    const key = groupKey(scope);
    let group = groups.get(key);
    if (group === undefined) {
      if (groups.size >= limits.maxPackages) {
        throw new RangeError(`package count exceeds maxPackages ${String(limits.maxPackages)}`);
      }
      group = { ...scope, deliveries: [] };
      groups.set(key, group);
    }
    try {
      group.deliveries.push({ position: event.position, value: restoreEventValue(event.value) });
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      group.deliveries.push({
        position: event.position,
        value: undefined,
        malformed: error.message,
      });
    }
  });

  const packages = [...groups.values()]
    .sort(
      (left, right) =>
        compareCodeUnits(left.network, right.network) ||
        compareCodeUnits(left.contract, right.contract) ||
        compareCodeUnits(bytesToHex(left.name), bytesToHex(right.name)) ||
        compareCodeUnits(left.transactionHash, right.transactionHash) ||
        left.segment - right.segment,
    )
    .map(evaluate);
  return { packages, ignored };
};
