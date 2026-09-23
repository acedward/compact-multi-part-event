/**
 * Independent strict reader for v1 multi-segment events.
 *
 * It parses bytes itself (it never calls the writer), recomputes SHA-256 with Node
 * crypto, and accepts a publication only when every part 001..nnn of one request ID
 * was emitted exactly once inside one transaction of one emitter, canonically
 * encoded. Events whose name lacks the 13-byte profile prefix are ignored as foreign;
 * a profile event must carry exactly the 32-byte name the circuit derives from its
 * tail (prefix, `ppp:nnn`, 12 zero bytes).
 *
 * Grouping key: (network, emitter, transaction, profile, request ID). Each event
 * carries an identity (`eventId`): the same identity delivered again with the same
 * bytes is a tolerated redelivery; the same bytes under two identities are an extra
 * emission and reject the group. Results do not depend on input order and are sorted
 * by code-unit order (not locale).
 *
 * @module
 */
import { createHash } from "node:crypto";

import {
  allZero,
  bytesEqual,
  bytesToHex,
  compareCodeUnits,
  readUint64LittleEndian,
} from "./bytes.js";
import {
  DATA_OFFSET,
  DEFAULT_READER_LIMITS,
  LENGTH_FIELD_OFFSET,
  NAME_LENGTH,
  NAME_POSITION_OFFSET,
  NAME_PREFIX_LENGTH,
  NAME_ZERO_OFFSET,
  namePrefix,
  PART_DATA_LENGTH,
  PAYLOAD_LENGTH,
  POSITION_FIELD_LENGTH,
  POSITION_TEXT_LENGTH,
  PROFILE,
  type CodecLimits,
  type ReaderLimits,
  REQUEST_ID_LENGTH,
  TAIL_LENGTH,
  validateCodecLimits,
  validateReaderLimits,
} from "./constants.js";
import { decodePosition } from "./position.js";

/** One public event as delivered by an event source (after width restoration). */
export interface PublicEvent {
  /** Network the source belongs to. */
  readonly network: string;
  /** Emitting contract address. */
  readonly emitter: string;
  /** Transaction containing the event. */
  readonly transactionId: string;
  /**
   * Stable identity of the emission within the source, e.g. an indexer event id or
   * the raw call position `segment:action`. Use one identity scheme per call.
   */
  readonly eventId: string;
  /** Exactly 32 bytes. */
  readonly name: Uint8Array;
  /** Exactly 256 bytes. */
  readonly payload: Uint8Array;
  /**
   * A defect the source observed for this emission (for example "emitted from a
   * fallible transcript"). It rejects the event's group.
   */
  readonly sourceIssue?: string;
}

/** Classification of one group. */
export enum ReadStatus {
  /** Every part is present, canonical and hashes to the request ID. */
  Complete = "complete",
  /** Every received part is valid but at least one is missing. */
  Incomplete = "incomplete",
  /** Something is malformed, repeated or conflicting. */
  Rejected = "rejected",
}

/** Scope of a result. `requestIdHex` is absent when an event could not be grouped. */
export interface PublicationScope {
  readonly network: string;
  readonly emitter: string;
  readonly transactionId: string;
  readonly profile: string;
  readonly requestIdHex?: string;
}

/** Result for one group, or for one event that could not be grouped. */
export interface ReadResult {
  readonly status: ReadStatus;
  readonly scope: PublicationScope;
  /** Declared part count, when all parts agree on it. */
  readonly expectedParts?: number;
  /** Distinct part numbers received from consistent emissions. */
  readonly receivedParts: number;
  /** Deliveries seen, redeliveries included. */
  readonly deliveries: number;
  /** Distinct event identities, sorted. */
  readonly eventIds: readonly string[];
  /** Reconstructed message (complete results only). */
  readonly message?: Uint8Array;
  /** Reasons, sorted and de-duplicated. */
  readonly issues: readonly string[];
}

/** Output of {@link readPublications}. */
export interface ReadOutput {
  /** Group results first (sorted by scope), then ungroupable rejections (sorted). */
  readonly results: readonly ReadResult[];
  /** Events skipped as foreign: no profile prefix, or outside the network/emitter filter. */
  readonly ignoredEvents: number;
}

/** Options for {@link readPublications}. */
export interface ReadOptions {
  readonly limits?: ReaderLimits;
  /** Only read events of this network; others are ignored. */
  readonly network?: string;
  /** Only read events of this emitter; others are ignored. */
  readonly emitter?: string;
}

/** A strictly decoded fragment. */
export interface DecodedFragment {
  readonly requestId: Uint8Array;
  readonly tail: Uint8Array;
  readonly position: number;
  readonly total: number;
  readonly messageLength: number;
}

const PREFIX = namePrefix();

/** Whether an event name carries the profile prefix (the reader's recognition rule). */
export const hasProfilePrefix = (name: Uint8Array): boolean =>
  name.byteLength >= NAME_PREFIX_LENGTH && bytesEqual(name.subarray(0, NAME_PREFIX_LENGTH), PREFIX);

/**
 * Strictly decode the name and payload of one profile event.
 *
 * @throws {RangeError} Describing the first violated rule.
 */
export const decodeFragment = (
  name: Uint8Array,
  payload: Uint8Array,
  limits: CodecLimits = DEFAULT_READER_LIMITS,
): DecodedFragment => {
  validateCodecLimits(limits);
  if (!hasProfilePrefix(name)) throw new RangeError("event name lacks the profile prefix");
  if (name.byteLength !== NAME_LENGTH) throw new RangeError("event name must be 32 bytes");
  if (payload.byteLength !== PAYLOAD_LENGTH)
    throw new RangeError("event payload must be 256 bytes");
  const requestId = payload.slice(0, REQUEST_ID_LENGTH);
  const tail = payload.slice(REQUEST_ID_LENGTH);
  if (tail.byteLength !== TAIL_LENGTH) throw new RangeError("tail must be 224 bytes");

  const { position, total } = decodePosition(tail.subarray(0, POSITION_FIELD_LENGTH));
  if (
    !bytesEqual(
      name.subarray(NAME_POSITION_OFFSET, NAME_POSITION_OFFSET + POSITION_TEXT_LENGTH),
      tail.subarray(0, POSITION_TEXT_LENGTH),
    )
  ) {
    throw new RangeError("event name bytes 13..19 differ from tail bytes 0..6");
  }
  if (!allZero(name.subarray(NAME_ZERO_OFFSET))) {
    throw new RangeError("event name bytes 20..31 are not zero");
  }
  const declaredLength = readUint64LittleEndian(tail, LENGTH_FIELD_OFFSET);
  if (declaredLength > BigInt(limits.maxMessageBytes)) {
    throw new RangeError(
      `message length exceeds maxMessageBytes ${String(limits.maxMessageBytes)}`,
    );
  }
  const messageLength = Number(declaredLength);
  if (total > limits.maxParts) {
    throw new RangeError(`part total ${String(total)} exceeds maxParts ${String(limits.maxParts)}`);
  }
  const canonicalTotal = Math.max(1, Math.ceil(messageLength / PART_DATA_LENGTH));
  if (total !== canonicalTotal) {
    throw new RangeError(
      `part total ${String(total)} is not canonical for message length ${String(messageLength)}`,
    );
  }
  const meaningful = Math.max(
    0,
    Math.min(PART_DATA_LENGTH, messageLength - (position - 1) * PART_DATA_LENGTH),
  );
  if (!allZero(tail.subarray(DATA_OFFSET + meaningful))) {
    throw new RangeError("tail has non-zero bytes after the message data");
  }
  return { requestId, tail, position, total, messageLength };
};

interface Emission {
  readonly eventId: string;
  readonly contentKey: string;
  readonly fragment?: DecodedFragment;
  readonly issue?: string;
}

interface Group {
  readonly scope: PublicationScope;
  readonly requestId: Uint8Array;
  readonly deliveries: Emission[];
}

const scopeKey = (scope: PublicationScope): string =>
  JSON.stringify([
    scope.network,
    scope.emitter,
    scope.transactionId,
    scope.profile,
    scope.requestIdHex ?? "",
  ]);

const sortedUnique = (values: readonly string[]): string[] =>
  [...new Set(values)].sort(compareCodeUnits);

const evaluateGroup = (group: Group): ReadResult => {
  const issues: string[] = [];
  const byEventId = new Map<string, Emission[]>();
  for (const delivery of group.deliveries) {
    const list = byEventId.get(delivery.eventId) ?? [];
    list.push(delivery);
    byEventId.set(delivery.eventId, list);
  }
  const emissions: Emission[] = [];
  for (const [eventId, list] of byEventId) {
    const contents = new Set(list.map((entry) => entry.contentKey));
    if (contents.size > 1) {
      issues.push(`event ${eventId} was delivered with different contents`);
      continue;
    }
    const [first] = list;
    if (first !== undefined) emissions.push(first);
  }
  for (const emission of emissions) {
    if (emission.issue !== undefined) issues.push(`malformed event in group: ${emission.issue}`);
  }
  const fragments = emissions.flatMap((emission) =>
    emission.fragment === undefined
      ? []
      : [{ eventId: emission.eventId, fragment: emission.fragment }],
  );
  const metadata = new Set(
    fragments.map(({ fragment }) => `${String(fragment.total)}/${String(fragment.messageLength)}`),
  );
  if (metadata.size > 1) issues.push("parts disagree on the part total or message length");

  const byPosition = new Map<number, { eventId: string; fragment: DecodedFragment }[]>();
  for (const entry of fragments) {
    const list = byPosition.get(entry.fragment.position) ?? [];
    list.push(entry);
    byPosition.set(entry.fragment.position, list);
  }
  for (const [position, list] of byPosition) {
    if (list.length < 2) continue;
    const tails = new Set(list.map(({ fragment }) => bytesToHex(fragment.tail)));
    issues.push(
      tails.size > 1
        ? `conflicting data for part ${String(position)}`
        : `part ${String(position)} was emitted ${String(list.length)} times`,
    );
  }

  const eventIds = sortedUnique([...byEventId.keys()]);
  const [firstFragment] = fragments;
  const common = {
    scope: group.scope,
    receivedParts: byPosition.size,
    deliveries: group.deliveries.length,
    eventIds,
  };
  const agreedTotal = metadata.size === 1 ? firstFragment?.fragment.total : undefined;
  if (issues.length > 0) {
    return {
      status: ReadStatus.Rejected,
      ...common,
      ...(agreedTotal === undefined ? {} : { expectedParts: agreedTotal }),
      issues: sortedUnique(issues),
    };
  }
  if (firstFragment === undefined || agreedTotal === undefined) {
    throw new Error("issue-free group without fragments");
  }
  const { total, messageLength } = firstFragment.fragment;
  const missing: number[] = [];
  for (let position = 1; position <= total; position += 1) {
    if (!byPosition.has(position)) missing.push(position);
  }
  if (missing.length > 0) {
    return {
      status: ReadStatus.Incomplete,
      ...common,
      expectedParts: total,
      issues: [`missing parts: ${missing.join(",")}`],
    };
  }
  const hash = createHash("sha256");
  const message = new Uint8Array(messageLength);
  for (let position = 1; position <= total; position += 1) {
    const tail = byPosition.get(position)?.[0]?.fragment.tail;
    if (tail === undefined) throw new Error("missing-part check did not protect reconstruction");
    hash.update(tail);
    const offset = (position - 1) * PART_DATA_LENGTH;
    const count = Math.min(PART_DATA_LENGTH, messageLength - offset);
    message.set(tail.subarray(DATA_OFFSET, DATA_OFFSET + count), offset);
  }
  if (!bytesEqual(Uint8Array.from(hash.digest()), group.requestId)) {
    return {
      status: ReadStatus.Rejected,
      ...common,
      expectedParts: total,
      issues: ["SHA-256 of the ordered tails does not match the request ID"],
    };
  }
  return { status: ReadStatus.Complete, ...common, expectedParts: total, message, issues: [] };
};

/**
 * Group, validate and reconstruct publications from public events.
 *
 * @param events - Events in any order, from any number of pages or reconnects.
 * @param options - Limits and optional network/emitter filters.
 * @throws {RangeError} If the limits are invalid or the input exceeds maxEvents/maxGroups.
 */
export const readPublications = (
  events: readonly PublicEvent[],
  options: ReadOptions = {},
): ReadOutput => {
  const limits = options.limits ?? DEFAULT_READER_LIMITS;
  validateReaderLimits(limits);
  if (events.length > limits.maxEvents) {
    throw new RangeError(
      `event count ${String(events.length)} exceeds maxEvents ${String(limits.maxEvents)}`,
    );
  }
  const groups = new Map<string, Group>();
  const ungroupable: ReadResult[] = [];
  let ignoredEvents = 0;

  for (const event of events) {
    if (
      (options.network !== undefined && event.network !== options.network) ||
      (options.emitter !== undefined && event.emitter !== options.emitter) ||
      !hasProfilePrefix(event.name)
    ) {
      ignoredEvents += 1;
      continue;
    }
    const baseScope = {
      network: event.network,
      emitter: event.emitter,
      transactionId: event.transactionId,
      profile: PROFILE,
    };
    const scopeComplete =
      event.network.length > 0 &&
      event.emitter.length > 0 &&
      event.transactionId.length > 0 &&
      event.eventId.length > 0;
    let fragment: DecodedFragment | undefined;
    let issue: string | undefined;
    try {
      fragment = decodeFragment(event.name, event.payload, limits);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      issue = error.message;
    }
    if (event.sourceIssue !== undefined) {
      issue = event.sourceIssue;
      fragment = undefined;
    }
    if (!scopeComplete || event.payload.byteLength < REQUEST_ID_LENGTH) {
      ungroupable.push({
        status: ReadStatus.Rejected,
        scope: baseScope,
        receivedParts: 0,
        deliveries: 1,
        eventIds: event.eventId.length > 0 ? [event.eventId] : [],
        issues: [
          scopeComplete
            ? `malformed event: ${issue ?? "payload shorter than a request ID"}`
            : "event has an empty network, emitter, transaction or event id",
        ],
      });
      continue;
    }
    const requestId = event.payload.slice(0, REQUEST_ID_LENGTH);
    const scope: PublicationScope = { ...baseScope, requestIdHex: bytesToHex(requestId) };
    const key = scopeKey(scope);
    let group = groups.get(key);
    if (group === undefined) {
      if (groups.size >= limits.maxGroups) {
        throw new RangeError(`group count exceeds maxGroups ${String(limits.maxGroups)}`);
      }
      group = { scope, requestId, deliveries: [] };
      groups.set(key, group);
    }
    group.deliveries.push({
      eventId: event.eventId,
      contentKey: `${bytesToHex(event.name)}/${bytesToHex(event.payload)}/${event.sourceIssue ?? ""}`,
      ...(fragment === undefined ? {} : { fragment }),
      ...(issue === undefined ? {} : { issue }),
    });
  }

  const grouped = [...groups.entries()]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([, group]) => evaluateGroup(group));
  const rest = ungroupable
    .map((result) => ({
      result,
      key: JSON.stringify([scopeKey(result.scope), result.eventIds, result.issues]),
    }))
    .sort((left, right) => compareCodeUnits(left.key, right.key))
    .map(({ result }) => result);
  return { results: [...grouped, ...rest], ignoredEvents };
};
