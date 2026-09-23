/**
 * Wire constants of the v1 multi-segment event profile.
 *
 * Event name (32 bytes): exactly `pad("mip-xxxx[v1]:ppp:nnn", 32)` — the 13 ASCII
 * bytes `mip-xxxx[v1]:`, the 7 bytes `ppp:nnn` copied from the tail, 12 zero bytes.
 * Event payload (256 bytes): 32-byte request ID, then the 224-byte tail. Tail: bytes
 * 0..6 ASCII `ppp:nnn` (1-based part and total, three zero-padded digits each), byte
 * 7 zero, bytes 8..15 the message length as uint64 little-endian, bytes 16..223 the
 * 208 data bytes of the part. `mip-xxxx` is an unassigned placeholder.
 *
 * @module
 */

/** Profile label used in grouping scopes. */
export const PROFILE = "mip-xxxx[v1]";

/** ASCII text of the fixed event-name prefix. */
export const NAME_PREFIX_TEXT = "mip-xxxx[v1]:";

/** Width of the fixed event-name prefix. */
export const NAME_PREFIX_LENGTH = 13;

/** Width of a `Misc` event name. */
export const NAME_LENGTH = 32;

/** Offset of the copied `ppp:nnn` text inside the event name. */
export const NAME_POSITION_OFFSET = 13;

/** Width of the `ppp:nnn` text (tail bytes 0..6, name bytes 13..19). */
export const POSITION_TEXT_LENGTH = 7;

/** Offset of the 12 zero bytes that end the event name (bytes 20..31). */
export const NAME_ZERO_OFFSET = 20;

/**
 * Width of the tail's position field that the circuit copies into the name (tail
 * bytes 0..7: the `ppp:nnn` text and one zero byte).
 */
export const POSITION_FIELD_LENGTH = 8;

/** Width of the request ID at the start of the event payload. */
export const REQUEST_ID_LENGTH = 32;

/** Width of one tail (the `emitPart` payload argument). */
export const TAIL_LENGTH = 224;

/** Offset of the uint64 little-endian message length inside a tail. */
export const LENGTH_FIELD_OFFSET = 8;

/** Offset of the message data inside a tail. */
export const DATA_OFFSET = 16;

/** Message bytes carried by one tail. */
export const PART_DATA_LENGTH = 208;

/** Width of a `Misc` event payload: request ID followed by the tail. */
export const PAYLOAD_LENGTH = REQUEST_ID_LENGTH + TAIL_LENGTH;

/** Width of the whole `Misc` event value: name followed by payload. */
export const EVENT_LENGTH = NAME_LENGTH + PAYLOAD_LENGTH;

/**
 * Largest part count the format can express (`999:999`). This is a format ceiling,
 * not a supported transaction capacity.
 */
export const FORMAT_MAX_PARTS = 999;

/** Allocation limits applied by the writer and to each group by the reader. */
export interface CodecLimits {
  /** Largest message length accepted, in bytes. */
  readonly maxMessageBytes: number;
  /** Largest part count accepted (1..{@link FORMAT_MAX_PARTS}). */
  readonly maxParts: number;
}

/** Limits for one reader invocation over untrusted events. */
export interface ReaderLimits extends CodecLimits {
  /** Largest number of events accepted in one call. */
  readonly maxEvents: number;
  /** Largest number of distinct publication groups accepted in one call. */
  readonly maxGroups: number;
}

/** Default codec limits: 64 parts (13,312 bytes), above the measured one-block fit of 46 parts. */
export const DEFAULT_CODEC_LIMITS: Readonly<CodecLimits> = Object.freeze({
  maxMessageBytes: 64 * PART_DATA_LENGTH,
  maxParts: 64,
});

/** Default reader limits. */
export const DEFAULT_READER_LIMITS: Readonly<ReaderLimits> = Object.freeze({
  ...DEFAULT_CODEC_LIMITS,
  maxEvents: 256,
  maxGroups: 128,
});

/** The 13-byte event-name prefix as a fresh array. */
export const namePrefix = (): Uint8Array => new TextEncoder().encode(NAME_PREFIX_TEXT);

/**
 * Validate codec limits.
 *
 * @throws {RangeError} If a limit is not a safe integer in its allowed range.
 */
export const validateCodecLimits = (limits: CodecLimits): void => {
  if (!Number.isSafeInteger(limits.maxMessageBytes) || limits.maxMessageBytes < 0) {
    throw new RangeError("maxMessageBytes must be a non-negative safe integer");
  }
  if (
    !Number.isSafeInteger(limits.maxParts) ||
    limits.maxParts < 1 ||
    limits.maxParts > FORMAT_MAX_PARTS
  ) {
    throw new RangeError(`maxParts must be an integer from 1 through ${String(FORMAT_MAX_PARTS)}`);
  }
};

/**
 * Validate reader limits.
 *
 * @throws {RangeError} If a limit is not a safe integer in its allowed range.
 */
export const validateReaderLimits = (limits: ReaderLimits): void => {
  validateCodecLimits(limits);
  if (!Number.isSafeInteger(limits.maxEvents) || limits.maxEvents < 1) {
    throw new RangeError("maxEvents must be a positive safe integer");
  }
  if (!Number.isSafeInteger(limits.maxGroups) || limits.maxGroups < 1) {
    throw new RangeError("maxGroups must be a positive safe integer");
  }
};
