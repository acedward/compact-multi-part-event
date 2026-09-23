/**
 * Transaction composition for multi-segment publications: build one aggregate,
 * guaranteed-only transaction through an injected contract binding, check the
 * publication intent at every stage, persist only public bytes and identifiers, and
 * submit exactly those bytes.
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
  buildPublicationTransaction,
  type BuiltPublication,
  canonicalKeyLocation,
  type ContractSnapshot,
  DEFAULT_MAX_ASSEMBLY_ATTEMPTS,
  DEFAULT_MAX_PARTS,
  DEFAULT_MAX_TTL_SECONDS,
  DEFAULT_TTL_SECONDS,
  type KeyLocationInput,
  type KeyLocationResolver,
  ledgerQueryContext,
  type PinnedBlock,
  prePartitionCallFor,
  preflightPublication,
  type PublicationConfig,
  type PublicationStateSource,
  requestIdHex,
  resolvePublicationConfig,
  retryUntilNonZeroSegment,
  type SerializableContractState,
  singleSegment,
} from "./compose.js";
export {
  type BuiltCall,
  buildCircuitCallTransaction,
  callIntentCheck,
  type CircuitCallPlan,
} from "./call.js";
export {
  type BuiltDeploy,
  buildDeployTransaction,
  deployIntentCheck,
  type DeployPlan,
} from "./deploy.js";
export {
  type FinalizedTransactionRecord,
  finalizeTransaction,
  type FinalizeTransactionOptions,
  type IntentCheck,
  submitSavedTransaction,
} from "./generic.js";
export {
  blockFullnessCheck,
  type CostCheck,
  expectedFromRecord,
  finalizePublication,
  type FinalizedPublication,
  type FinalizeOptions,
  locatePublication,
  type PublicationBalancer,
  type PublicationLocation,
  type PublicationProver,
  type PublicationSubmitter,
  submitPublication,
} from "./finalize.js";
export {
  assertPublicationIntent,
  type ExpectedPublication,
  PublicationCheckError,
} from "./guard.js";
