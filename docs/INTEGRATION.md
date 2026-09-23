# Integrating multi-segment emission into your own contract

This is the procedure for a contract that is not the reference emitter. You need
`contracts/modules/` (Compact) and this library's public entry points (TypeScript):

| Entry point                                        | What it gives you                                                                 | Loads                      |
| -------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------- |
| `compact-multi-segment-emit/codec`                 | writer, strict reader, width restoration                                          | Node `crypto` only         |
| `compact-multi-segment-emit/codec/raw-transaction` | emission extraction and wallet-free verification of raw transactions              | ledger-v9                  |
| `compact-multi-segment-emit/transaction`           | binding, composer, stage checks, finalize/submit, deploy and single-call builders | ledger-v9, compact-runtime |
| `compact-multi-segment-emit/contract`              | off-chain commitments and witnesses of the two access-control examples            | Node `crypto` only         |
| `compact-multi-segment-emit/adapters`              | indexer, proof server, wallet, zk artifacts, protected secret files               | the Midnight SDK packages  |

The package is not published to the npm registry. Build it (`npm run build`), pack it
(`npm pack`) and depend on the tarball, as `scripts/check-external-consumer.sh` does, and
copy the three `overrides` of
[examples/consumer/package.json](../examples/consumer/package.json) into your project so
one ledger-v9, one compact-runtime and one onchain-runtime-v4 are installed
(`node scripts/check-pins.mjs <your project directory>` checks it after `npm install`).

## The two invariants

1. **The emission circuit writes nothing.** Every part of a publication is executed from
   the same pinned pre-state and the calls are partitioned together, so a part must not
   depend on another part's effects. `emitPart` may read access-control state that the
   publication does not change (a sealed authority, a registry entry) and then emit. A
   circuit that writes state, reads state another transaction can change before
   inclusion, or reads the block time without the pinned block's clock, is outside this
   pattern. Such a publication does not partially apply; the whole transaction is
   rejected.
2. **The event bytes are the module's.** Call `emitPartEvent(requestId, payload)` exactly
   once per part and add nothing to the event. Readers recognize the profile by the name
   prefix and check the rest byte for byte.

## Step 1: the Compact side

```compact
pragma language_version >= 0.26;
import CompactStandardLibrary;
import "modules/MultiSegmentEmit";
import "modules/MessageRegistry";          // or "modules/EmitterWhitelist", or your own check

export { messageOwnerOf, messageOwner };

export circuit register3(requestId: Bytes<32>, tails: Vector<3, Bytes<224>>): [] {
  registerMessage<3>(requestId, tails);    // export one per message size you accept
}

export circuit emitPart(requestId: Bytes<32>, payload: Bytes<224>): [] {
  assertMessageOwner(requestId);           // read only
  emitPartEvent(requestId, payload);
}
```

Choosing the access control (both are examples; pick per use case, alone or together):

- **`EmitterWhitelist`**: one emitter. The constructor stores
  `emitterAuthorityOf(secret)` (SHA-256 of a domain tag and the secret, computed off
  chain with `emitterAuthorityOf` from `/contract`); `assertEmitterAuthority()` checks the
  `emitterSecret` witness. See [contracts/emitter.compact](../contracts/emitter.compact).
- **`MessageRegistry`**: several users. `registerMessage<N>` recomputes the request ID
  from the private tails, refuses a second registration and stores the owner's
  commitment; `assertMessageOwner` checks the `messageOwnerSecret` witness. Register in
  an EARLIER transaction than the parts: in one transaction the tails would be visible in
  the mempool before the registration lands. `releaseMessage` removes the entry and runs
  after every part, never inside one. Size grows by about 7,100 rows per part (k=19 from
  about 37 parts); export only the N you need.
- **Neither**: anyone can emit under your address; readers still reject incomplete or
  wrong-hash groups, but a stranger's extra part in your publication's transaction makes
  it unreadable.

Whatever you choose, the maintenance authority of the deployed contract outranks it: it
can remove every circuit and install new ones.

## Step 2: build and keys

```sh
npm run compile       # compactc 0.34.0 --feature-zkir-v3 --skip-zk
npm run compile:zk    # full keys into build/zk/<name>
```

Commit the small verifier keys with the `SHA256SUMS` of every artifact and regenerate
them in CI (`scripts/keys.sh update|verify`); prover keys are tens to hundreds of MB and
are rebuilt, not committed. The verifier key installed at deployment must be byte for
byte the one you prove with: provers look keys up by its SHA-256.

## Step 3: the client

```ts
import { encodePublication } from "compact-multi-segment-emit/codec";
import {
  bindingFromContract,
  blockFullnessCheck,
  buildPublicationTransaction,
  finalizePublication,
  submitPublication,
} from "compact-multi-segment-emit/transaction";
import {
  IndexerClient,
  indexerStateSource,
  proofServerProver,
  waitForTransaction,
  WalletSession,
  zkConfigForContract,
  ledgerParametersFromHex,
} from "compact-multi-segment-emit/adapters";
import { messageOwnerWitnesses } from "compact-multi-segment-emit/contract";
import { Contract } from "./managed/my-contract/contract/index.js";

const indexer = new IndexerClient({ url: INDEXER_URL });
const parameters = ledgerParametersFromHex((await indexer.latestBlock()).ledgerParametersHex!);
const wallet = await WalletSession.open({
  network,
  mnemonicFile,
  dustParameters: parameters.dust,
  syncTimeoutMs: 60 * 60_000, // the default; a first sync can take long
  feeBlocksMargin: 5, // the default: the fee covers 5 blocks of price rises (0..100)
  stateCacheFile, // optional: protected wallet-state cache, restored on the next run
  log: console.error, // public progress every 30 s
});
await wallet.synced(); // complete sync of all three sub-wallets, or WalletNotSyncedError
const prover = proofServerProver({
  url: LOCAL_PROOF_SERVER,
  zkConfig: zkConfigForContract({ artifactDir: "build/zk/my-contract", expectedVerifierKeys }),
});

const binding = bindingFromContract(new Contract(messageOwnerWitnesses), "emitPart", () => ({
  messageOwnerSecret: ownerSecret,
}));
const built = await buildPublicationTransaction(
  indexerStateSource(indexer),
  binding,
  { network: "stagenet", emitter: address, coinPublicKey: wallet.coinPublicKey() },
  encodePublication(message),
);
const record = await finalizePublication({ prover, balancer: wallet.balancer() }, built, {
  proofTimeoutMs: 900_000,
  costCheck: blockFullnessCheck(1),
});
// persist `record` (public bytes and identifiers only), then:
await submitPublication(wallet.submitter(), record);
const included = await waitForTransaction(indexer, { identifiers: record.identifiers });
```

What each step guarantees:

- `WalletSession.synced()` (`balances()` and the DUST registration call it too; call it
  yourself before building and balancing) resolves only after a complete sync: the shielded and
  DUST wallets have applied every ledger event up to the `maxId` the indexer reports
  (`progress.appliedIndex` against `progress.highestRelevantWalletIndex`), the
  unshielded wallet every transaction up to the indexer's highest one for the address
  (`progress.appliedId` against `progress.highestTransactionId`), all three connected,
  and they stay caught up for 3 consecutive 5 s samples. The facade's `isSynced` flag is
  not relied on. Otherwise it throws `WalletNotSyncedError` with the last public
  progress after `syncTimeoutMs`; never treat balances read before that as final.
  `waitForCompleteSync` applies the same rule to any facade state stream. With
  `stateCacheFile` the state saved after a complete sync (before the session builds a
  transaction) is restored next time; the file is bound to the wallet's public identity,
  network and SDK version, and must be mode 0600 and outside every Git working tree.
  `feeBlocksMargin` (default 5, an integer from 0 to 100) is the facade's
  `costParameters.feeBlocksMargin`: the wallet declares the required fee ×
  `maxPriceAdjustment^margin`, and the ledger consumes the declared fee.
- `buildPublicationTransaction` refuses a non-canonical or over-cap publication before
  any network access, reads ONE latest block and the state as of that block (with the
  network's ledger parameters), executes every part with the block time in seconds,
  checks each execution (one trace, one `Misc` event with exactly the expected bytes, no
  cross-contract call, no coins), and partitions all calls with one
  `addCalls({ tag: "guaranteedOnly" })`, rebuilding if the ledger draws segment 0.
- `finalizePublication` checks the publication intent before proving, after proving,
  after balancing (the build TTL is passed to the wallet) and after a serialization round
  trip, and runs the block-fullness check on the proven and on the balanced transaction
  against the pinned parameters. The record holds only public data.
- `submitPublication` re-checks the saved bytes, hash, identifiers and intent hash and
  submits exactly those bytes once. If the transaction does not show up before its TTL,
  it was not included: inspect public state; never resubmit blindly or rebuild. A merge
  by someone else changes the hash; `locatePublication` finds your intent by its
  identifiers and intent hash.
- The prover adapter limits concurrent proof requests (default 4) and retries HTTP 408,
  429, 502, 504 and connection resets with bounded backoff, all before submission. It
  refuses any answer that is not a proven ledger-v9 transaction of this process.

The registration and any state-changing application step are single calls:
`buildCircuitCallTransaction` + `finalizeTransaction` + `submitSavedTransaction` with
`callIntentCheck`, each in its own transaction. [examples/consumer/src](../examples/consumer/src)
shows all of it, and its offline demo runs the flow on a local ledger.

## Step 4: what your consumers run

```sh
npm run cmse -- verify --contract <address> --tx <hash> --kind consumer --node <node rpc>
```

or, from code, `verifyPublicationTransaction(rawBytes, { emitter, entryPoint, network,
status, transactionHash })` from `/codec/raw-transaction` and `readPublications` from
`/codec`. Event sources MUST restore the 32/256-byte widths before strict decoding (the
ledger trims trailing zeros of event values); `restoreEventValue` and
`restoreIndexerMiscEvent` do it, and the raw reader never accepts short payloads. The
levels and exit statuses are in the [README](../README.md#how-to-verify).

## Checklist

- [ ] `emitPart(requestId: Bytes<32>, payload: Bytes<224>)` calls `emitPartEvent` once and writes no state.
- [ ] An access control that fits your contract (whitelist, registration, or your own), and the maintenance authority it ranks below documented.
- [ ] With the registration: `register<N>` exported for your sizes, registered in an earlier transaction, `release` only after every part.
- [ ] Verifier keys committed with `SHA256SUMS`; the deployed keys are the committed ones.
- [ ] The client pins one block, uses the network's ledger parameters, and keeps the default or a measured `maxParts`.
- [ ] Witness secrets and the mnemonic are files (mode 0600, outside every repository); the proof server is yours and local.
- [ ] The wallet is completely synced (`synced()`) before balances are read or a transaction is balanced; an incomplete sync is reported as "not synced", never as a zero balance.
- [ ] Records persisted before submission; inclusion tracked by identifiers; no blind resubmission.
- [ ] Readers verify from raw transaction bytes (Level 2) and, where it matters, against a node (`--node`).
