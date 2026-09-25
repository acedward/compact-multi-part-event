# compact-multi-segment-emit

## Summary

`mip-xxxx:multi-part[v1]` (short: `mip-xxxx`) lets a Midnight protocol publish an event larger than one `Misc` payload. It is an opt-in processing rule for an event the protocol already emits, not a new event: it defines no event name, no field and no bytes on chain. A protocol whose contracts emit `Misc` events named N states in its own specification that N follows `mip-xxxx:multi-part[v1]`; every reader then merges all N events one contract emitted from one intent of one transaction, in emission order, into one payload, and processes that payload exactly as it processes a normal N event.

For example, if the protocol `mip-9931` emits `mip-9931:cool-beans[v1]` and opts in, an intent that holds three `mip-9931:cool-beans[v1]` events is one cool-beans event whose payload is their 768 bytes, and an intent that holds one is processed exactly as before.

Targets Midnight 2.x (ledger v9, stagenet's ledger 9.1) and Compact 0.34.0. This is a draft: `xxxx` is an unassigned placeholder until the proposal is published, and the repository carries only version 1. The idea of publishing one event in several parts comes from SIG Network (https://sig.network).

## How to use

For the author of a protocol and its contracts. The library and `cmse` need Node 24; the repository's checks run in Docker.

1. **Declare the opt-in in your specification.** For example: "Events named `mip-9931:cool-beans[v1]` follow `mip-xxxx:multi-part[v1]`." Your payload format must read correctly at any multiple of 256 bytes, because the last part is zero-padded: carry your own length, type or checksum if you need one. Never emit two independent N events from one contract in one intent: readers would merge them.

2. **Emit your own event, once per part.** The standard has no Compact code of its own. The reference adopter, `contract-examples/emitter`, emits `example:message[v1]`:

   ```compact
   export circuit emitPart(payload: Bytes<256>): [] {
     assertEmitterAuthority();   // your access control; this one is contract-examples/whitelist
     emit (Misc { name: pad(32, "example:message[v1]"), payload: disclose(payload) });
   }
   ```

   Keep the emitting circuit free of state writes: every part of a package runs from the same pre-state. The access control is yours to choose; `contract-examples/whitelist` is an example. `contract-examples/notice-board` is a second adopter, with state of its own and its event `notice-board:notice[v1]`, built as a separate project against the packed library.

3. **Publish all parts in one intent.** With `src/publisher` (`compact-multi-segment-emit/publisher`) and your own wallet and proof providers:

   ```ts
   const built = await buildPackageTransaction(
     stateSource,
     { network, coinPublicKey },
     {
       contract: address,
       name: "example:message[v1]",
       binding: bindingFromContract(new Contract(witnesses), "emitPart", () => privateState),
       parts: splitPayload(payload),
     },
   );
   const record = await finalizeTransactionPackages({ prover, balancer }, built, {
     proofTimeoutMs,
   });
   // Save `record` (public bytes and identifiers only), then submit exactly those bytes once.
   await submitRecord(submitter, record);
   ```

   The publisher runs your circuit once per part against one pinned block and state, puts every call into one guaranteed-only intent (`Transaction.addCalls({ tag: "guaranteedOnly" }, …)`), and checks that intent before proving, after proving, after balancing and after a serialization round trip. `buildPackagesTransaction` puts several packages into one transaction, one intent each. The default cap is 8 parts (`maxParts`); the block limits decide the real maximum. `indexerStateSource` from `compact-multi-segment-emit/indexer` reads the pinned state from a public indexer, and `locateRecord` finds your packages in the included transaction, even if others merged intents into it.

   `deploy-tools` shows the whole flow for this repository's examples on a live network: `npm run deploy-tools -- --help` lists `funding`, `deploy`, `publish` (several messages go into one transaction, one intent each) and `pin`, with every flag and environment variable. It needs the compiled examples and their proving keys (`npm run compile` and `npm run compile:zk`, with `compactc` 0.34.0 on `PATH`), a local proof server and a funded wallet.

4. **Read and verify packages.** A reader configures the opted-in (contract, N) pairs and calls `readPackages` from `compact-multi-segment-emit/reader` on the contract's events (`partEventsFromIndexer` from `compact-multi-segment-emit/indexer` converts the indexer's). From a clone, `cmse verify` checks packages from public data, without a wallet, proof server or compiler:

   ```sh
   npm ci && npm run build
   npm run cmse -- verify --contract <address> --name 'example:message[v1]' --tx <transaction hash> \
     --verifier-key contract-examples/emitter/keys/emitPart.verifier --node <node rpc url>
   ```

   Quote the name: `[ ]` are shell patterns. `--example emitter` (or `notice-board`) sets the name and the committed key of this repository's examples. It reads stagenet's public indexer unless `--network` or `--indexer` says otherwise.

   | Level            | Checks                                                                                                                                                                                                                                                                  |
   | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | 1, the package   | the contract's `Misc` events named N, grouped per intent, in ledger emission order, widths restored and merged                                                                                                                                                          |
   | 2, the placement | from the raw transaction: included (`SUCCESS` or `PARTIAL_SUCCESS`), the bytes hash to it, every call of the emitting circuit in the package's intent is guaranteed-only and logs exactly the package's parts in order; with `--node`, the node's block holds the bytes |
   | 3, the code      | the verifier key the contract stored for the emitting circuit, at the transaction's block, equals the committed one, which `scripts/check.sh` regenerates from source                                                                                                   |

   | Exit status | Meaning                                                              |
   | ----------- | -------------------------------------------------------------------- |
   | 0           | every package verified to the requested level (`--level`, default 3) |
   | 1           | a level failed                                                       |
   | 2           | usage or input error                                                 |
   | 3           | not found: not indexed yet, or a wrong hash, address or name         |

   Without `--tx`, `verify` lists and verifies every package of the (contract, N), paging through the contract's `Misc` events. `--segment <n>` picks one package of a transaction. `--raw-file <file> --status SUCCESS [--state-file <file>]` verifies saved bytes offline. `--json` prints the report; run it as `npm run -s cmse -- …` so npm's header stays off stdout. Proofs are not verified again: inclusion means the network verified them. `npm run cmse -- --help` lists every flag.

5. **Check a live package.** Both examples run on stagenet, deployed and exercised with `deploy-tools`: the reference emitter at `717ae53b7559d3f90e78639ff13ee09571480f5b51a09bea901bf44a398aff46` and the notice board at `c6e33a04cfeaee77f65e87127801443fad234d75d40d8c4b3c9bac6e37478335`. Transaction `ea9a10587113ddf67cfae81770b4e22e33a18f053c69aaf5c4811e423c7722d8`, in block 610186, holds a package of four parts (1,000 bytes, the last part zero-padded). From a clone, after `npm ci && npm run build`:

   ```sh
   npm run -s cmse -- verify --example emitter \
     --contract 717ae53b7559d3f90e78639ff13ee09571480f5b51a09bea901bf44a398aff46 \
     --tx ea9a10587113ddf67cfae81770b4e22e33a18f053c69aaf5c4811e423c7722d8 \
     --node https://rpc.stagenet.shielded.tools
   ```

   exits 0 and prints, after the source, contract, name, transaction and expected key:

   ```text
   package     transaction ea9a10587113ddf67cfae81770b4e22e33a18f053c69aaf5c4811e423c7722d8, segment 25599, block 610186
     L1 OK   4 part(s), 1024 bytes, payload SHA-256 953bffde819941614fa6a0b245955707bc94111cc1fd04d197f75911558170d8
     L2 OK   included, status SUCCESS
     L2 OK   the raw bytes hash to the transaction
     L2 OK   the node's block 610186 holds the raw bytes (extrinsic 3)
     L2 OK   every emitPart call in the intent at segment 25599 is guaranteed-only and logs these 4 part(s), in order
     L3 OK   the deployed emitPart verifier key at block 610186 equals the expected one (SHA-256 b25a6c6a565fde435afeacbae73434a9db2730f871e53da589395a27144842d7)
     verified to level 3
   result      1 package(s); verified to level 3 of 3 — and the code: the deployed emitting circuit's verifier key is the committed one
   ```

   Without `--tx` it lists and verifies every package the emitter has published, among them the two packages, in two intents, of transaction `75c7cab734175deb00264c13ee975bef57c8a2d31ce36441e76ca4d793f1422a`. The notice board's notices verify the same way with `--example notice-board`.

6. **Run the checks.** `scripts/check.sh` runs everything in Docker: install from the lockfile, the pinned packages, compilation, key regeneration against the committed hashes (with each circuit's size), format, type-aware lint, typecheck, build, tests, the notice board's separate-project build, and the repository check (label policy over the full history, and the file layout). `scripts/check.sh --fresh-clone` does the same from a clean clone.

## Spec

**The rule.** A protocol P whose contracts emit `Misc` events named N opts in by stating in its own specification that N follows `mip-xxxx:multi-part[v1]` (or just `mip-xxxx`). Then, for every reader of P:

1. **Grouping.** All events named N that one contract emitted from one intent (one physical segment) of one included transaction form one package, in their emission order.
2. **Merging.** The package's payload is the concatenation of the events' 256-byte payloads. A single event is a package of one part, so opting in changes nothing for single events.
3. **Processing.** The merged payload is processed exactly as P processes the payload of a normal N event. P's payload format must therefore be readable at any multiple of 256 bytes; P carries its own length, type or checksum if it needs one.
4. **P's obligations.** Publishers put all parts of one logical N event in one intent, all guaranteed, in order. P never emits two independent N events from one contract in one intent, because they would be merged into one.

Events whose protocol did not opt in are untouched. Which (contract, N) pairs opted in is known from P's specification, not from the chain. After inclusion a package is identified by (network, contract, N, transaction hash, physical segment). Before inclusion the publisher tracks it by the transaction's identifiers and the intent's hash: a merge changes the transaction hash, never the segment or the intent. This version places parts in the guaranteed section only.

**Ledger facts the rule relies on** (ledger 9.1):

- A transaction holds its intents in a map from segment number to intent; segment 0 is the guaranteed section and never holds an intent. Merging two transactions whose intents share a segment number is refused.
- An intent's seal covers its segment number and all its contents, including every contract call. After sealing nobody can add, remove, change or move a call; a merge can only add other intents at other segment numbers.
- The ledger applies all guaranteed calls first, intents in ascending segment order and calls in their sealed order, then each fallible segment. A guaranteed failure fails the whole transaction, which is not included, so a guaranteed package lands whole, in order, or not at all.
- Every event carries `EventSource { transaction_hash, logical_segment, physical_segment }`. `physical_segment` identifies the intent; `logical_segment` is always 0.
- A `Misc` event is a 32-byte name and a 256-byte payload. The ledger trims the trailing zero bytes of the logged value, so readers restore both widths.

**The reader**, for each configured (contract, N):

- takes only the contract's `Misc` events whose name, restored to 32 bytes, is exactly N, and restores each payload to 256 bytes;
- groups them by (network, contract, N, transaction hash, physical segment), the segment coming from the event's `EventSource` or from the intent's key in the raw transaction;
- orders each group by the call's index in the raw intent, or by event ids that follow ledger emission order, never by delivery order;
- accepts an identical redelivery of one event, and rejects a package in which one event arrives with two contents;
- returns each group's concatenated payload, bounded in events and packages, and never interprets it.

The indexer has no name filter: a reader pages through `contractEvents(filter: { contractAddress, types: [MISC] })`, at most 500 events a page, and must fetch every event of an intent before merging; the raw transaction shows a missing part. For per-segment results use the indexer's `transactionResult.segments`, not the ledger-v9 JavaScript `TransactionResult.successfulSegments`, which is inverted (`true` means failed) until ledger 10.

**Limits.** A package is bounded by the block limits, and block size is the dimension that binds: each part adds one call with its proof, about 5.9 KB. With real proofs of this repository's `emitPart` (k = 16, 41,546 rows, provisional), a package of 169 parts fits a block under stagenet's parameters (170 does not) and 33 under the ledger's default parameters (34 does not), measured before a wallet adds its fee-paying intent. The publisher refuses a transaction that does not fit after proving and after balancing; its default cap is 8 parts, configurable up to 1,024.

**Security.**

- Authorship comes from the contract's access control, not from the rule. The seal gives a package integrity, not identity: on an open contract anyone can publish a package in an intent of their own, even inside your transaction.
- The contract's maintenance authority outranks its access control: it can replace the emitting circuit. Readers who trust a contract's packages also trust that authority; Level 3 shows the key at the package's block.
- The payload's integrity and meaning are the adopter's: length, type and checksum belong to P's format.
- A proof server sees every witness, the access-control secret included: prove locally. `deploy-tools` accepts only a loopback proof server unless told otherwise, and takes secrets as file paths only (mode 0600, outside every Git working tree).
- `verify` trusts the indexer for the events and the state; `--node` checks the raw transaction against the node's block.
