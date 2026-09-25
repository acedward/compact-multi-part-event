/**
 * The publisher of the multi-part rule, for adopters' clients: split a payload into
 * 256-byte parts, run the adopter's emitting circuit once per part against one pinned
 * state, put all parts of a package into ONE guaranteed-only intent (several packages
 * per transaction, one intent each), check each package's intent at every stage, and
 * prove, balance and submit through injected providers; then locate the packages after
 * inclusion.
 *
 * @module
 */
export {
  bindingFromContract,
  type ContractWithEmission,
  type EmissionBinding,
  type EmitPartCircuit,
} from "./binding.js";
export {
  addGuaranteedIntent,
  buildPackagesTransaction,
  buildPackageTransaction,
  type BuiltTransaction,
  canonicalKeyLocation,
  type ContractSnapshot,
  DEFAULT_MAX_ASSEMBLY_ATTEMPTS,
  DEFAULT_MAX_PARTS,
  DEFAULT_MAX_TTL_SECONDS,
  DEFAULT_TTL_SECONDS,
  type KeyLocationInput,
  type KeyLocationResolver,
  ledgerQueryContext,
  MAX_PACKAGES,
  MAX_PARTS_CEILING,
  nameHex,
  type PackageRequest,
  type PinnedBlock,
  prePartitionCallFor,
  preflightPackage,
  type PublicationStateSource,
  type PublisherConfig,
  resolvePublisherConfig,
  type SerializableContractState,
} from "./compose.js";
export {
  blockFullnessCheck,
  type CostCheck,
  deserializeFinal,
  expectedFromRecord,
  type FinalizedRecord,
  type FinalizeOptions,
  finalizeTransactionPackages,
  locateRecord,
  type PackageRecord,
  type PublicationBalancer,
  type PublicationProver,
  type PublicationSubmitter,
  type RecordLocation,
  submitRecord,
} from "./finalize.js";
export {
  type FinalizedTransactionRecord,
  finalizeTransaction,
  type FinalizeTransactionOptions,
  type IntentCheck,
  submitSavedTransaction,
} from "./generic.js";
export {
  assertPackageIntent,
  assertTransactionPackages,
  type ExpectedPackage,
  PackageCheckError,
} from "./guard.js";
export { PART_LENGTH, partCountFor, splitPayload } from "./parts.js";
