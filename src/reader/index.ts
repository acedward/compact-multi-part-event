/**
 * The reader of the multi-part rule, for every reader of an adopting protocol: packages
 * from events (group per intent, order, merge), width restoration, and the placement
 * check against the raw transaction. No wallet, no network access.
 *
 * @module
 */
export { bytesEqual, bytesToHex, compareCodeUnits, hexToBytes } from "./bytes.js";
export {
  EVENT_LENGTH,
  eventName,
  eventNameText,
  eventValue,
  type IndexerMiscFields,
  NAME_LENGTH,
  PAYLOAD_LENGTH,
  restoreEventValue,
  restoreIndexerMiscEvent,
  type RestoredEvent,
  splitEventValue,
} from "./event.js";
export {
  DEFAULT_READER_LIMITS,
  type OptIn,
  type Package,
  type PartEvent,
  readPackages,
  type ReaderLimits,
  type ReadOptions,
  type ReadOutput,
  validateReaderLimits,
} from "./packages.js";
export {
  type AnyTransaction,
  type CheckedPackage,
  checkPlacement,
  contractActivity,
  type ContractActivity,
  type ContractCallSummary,
  decodeMiscValue,
  deserializeTransaction,
  entryPointText,
  INCLUDED_STATUSES,
  type LedgerEventOptions,
  type LoggedEvent,
  loggedEvents,
  type LoggedPart,
  MISC_EVENT_TYPE_CODE,
  partEventsFromLedgerEvents,
  partEventsFromTransaction,
  payloadHex,
  type PlacementTarget,
  statusFromLedgerResult,
  transactionHashOf,
  type TransactionScope,
  type TransactionVerification,
  verifyTransactionPackages,
  type VerifyTransactionOptions,
} from "./transaction.js";
