/**
 * Infrastructure adapters: indexer (public data), proof server, wallet, zero-knowledge
 * artifacts and protected secret files. They compose the codec and transaction modules
 * from outside; nothing in `../codec` or `../transaction` imports them.
 *
 * @module
 */
export {
  hexOf,
  type IndexedBlock,
  type IndexedContractState,
  type IndexedMiscEvent,
  type IndexedTransaction,
  IndexerClient,
  type IndexerClientOptions,
  type IndexerEventConversion,
  indexerStateSource,
  ledgerParametersFromHex,
  MAX_EVENT_PAGE,
  type NodeRpcOptions,
  PublicDataError,
  publicEventsFromIndexer,
  rawTransactionInBlock,
  waitForTransaction,
  type WaitOptions,
} from "./indexer.js";
export {
  limitedProvingEndpoint,
  proofServerProver,
  type ProofServerProverOptions,
  ProverAnswerError,
  proverFromEndpoint,
  type ProverPolicy,
  type ProvenTransaction,
  type ProvingEndpoint,
  requireProvenTransaction,
  retryableProofError,
  type RetryEvent,
} from "./prover.js";
export {
  type CreateSecretOptions,
  createWitnessSecretFile,
  enclosingRepository,
  readProtectedFile,
  readSigningKeyFile,
  readWitnessSecret,
  SecretFileError,
  type StoredSigningKey,
  WITNESS_SECRET_LENGTH,
  writeSecretFile,
  writeSigningKeyFile,
} from "./secrets.js";
export {
  deriveWalletKeys,
  type DustRegistrationReport,
  type NightUtxo,
  publicIdentity,
  type PublicWalletIdentity,
  readMnemonicFile,
  type WalletBalances,
  type WalletKeys,
  type WalletNetwork,
  WalletSession,
  type WalletSessionOptions,
} from "./wallet.js";
export {
  ArtifactMismatchError,
  assertVerifierKeyEquals,
  checkArtifactHashes,
  parseSha256Sums,
  readVerifierKey,
  verifierKeyHash,
  verifierKeyPath,
  zkConfigForContract,
  type ZkConfigOptions,
} from "./zk-config.js";
