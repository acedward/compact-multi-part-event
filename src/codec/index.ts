/**
 * Byte-level codec of the v1 multi-segment event profile: writer, strict reader and
 * width restoration. This entry point depends only on Node's `crypto`; it loads no
 * ledger, wallet, network, prover or generated contract code. Raw-transaction
 * extraction lives in `./raw-transaction` because it needs the ledger package.
 *
 * @module
 */
export { bytesToHex, compareCodeUnits, hexToBytes } from "./bytes.js";
export {
  type CodecLimits,
  DATA_OFFSET,
  DEFAULT_CODEC_LIMITS,
  DEFAULT_READER_LIMITS,
  EVENT_LENGTH,
  FORMAT_MAX_PARTS,
  LENGTH_FIELD_OFFSET,
  NAME_LENGTH,
  NAME_POSITION_OFFSET,
  NAME_PREFIX_LENGTH,
  NAME_PREFIX_TEXT,
  NAME_ZERO_OFFSET,
  namePrefix,
  PART_DATA_LENGTH,
  PAYLOAD_LENGTH,
  POSITION_FIELD_LENGTH,
  POSITION_TEXT_LENGTH,
  PROFILE,
  type ReaderLimits,
  REQUEST_ID_LENGTH,
  TAIL_LENGTH,
  validateCodecLimits,
  validateReaderLimits,
} from "./constants.js";
export { decodePosition, encodePosition, type PartPosition } from "./position.js";
export {
  decodeFragment,
  type DecodedFragment,
  hasProfilePrefix,
  type PublicationScope,
  type PublicEvent,
  type ReadOptions,
  type ReadOutput,
  readPublications,
  type ReadResult,
  ReadStatus,
} from "./reader.js";
export {
  type IndexerMiscFields,
  restoreEventValue,
  restoreIndexerMiscEvent,
  type RestoredEvent,
} from "./widths.js";
export {
  type EncodedPart,
  type EncodedPublication,
  encodePublication,
  eventNameFor,
  eventPayloadFor,
  eventValueFor,
  partCountFor,
} from "./writer.js";
