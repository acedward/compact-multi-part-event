# Compact multi-segment event emission

This repo aims to describe a standard mechanism to publish a message of any size through
Midnight contract events.

1. The client splits the message into 224-byte parts (each carries 16 bytes of position
   and length metadata and 208 message bytes).
2. The client calculates the hash of the message (the request ID: SHA-256 of the ordered
   parts).
3. The client calls one small circuit, `emitPart(requestId, payload)`, per part.
4. The client combines all calls into one transaction, all in its guaranteed section.
5. Each call emits one `Misc` event.
6. A reader accepts the message only when (a) every part was emitted by the expected
   contract, (b) in a single transaction, (c) the parts hash to the request ID, and (d)
   parts 1..n of n are each present exactly once.

Note: nothing is stored in contract state.

Targets Midnight 2.x (ledger v9) with event support, compiled with Compact 0.34.0. Event
names start with `mip-xxxx[v1]:`, where `mip-xxxx` is an unassigned placeholder, not an
assigned number.

## How to use

For a contract author. The full procedure, with a checklist, is in
[docs/INTEGRATION.md](docs/INTEGRATION.md); [examples/consumer](examples/consumer) is a
complete second contract that uses the pattern from outside the library.

1. **Add the circuit to your contract.** Copy `contracts/modules/` next to it, import the
   event format and export one emission circuit:

   ```compact
   pragma language_version >= 0.26;
   import CompactStandardLibrary;
   import "modules/MultiSegmentEmit";

   // Optional, and not part of the event format: only the holder of a secret may emit.
   // import "modules/EmitterWhitelist";
   // constructor(authority: Bytes<32>) { initializeEmitterAuthority(authority); }

   export circuit emitPart(requestId: Bytes<32>, payload: Bytes<224>): [] {
     // assertEmitterAuthority();
     emitPartEvent(requestId, payload);
   }
   ```

   Keep the emission circuit free of state writes: every part of a publication is
   executed from the same pre-state.

2. **Decide who may emit.** Without a check, anyone can call your `emitPart`. The
   repository ships two access controls. They are **examples**, not part of the event
   format; the right choice depends on your use case, and they can be used alone or
   together (and/or). Publishing itself writes nothing; each example keeps only its own
   small ledger entries.
   - **Whitelist of publishers by the hash of a secret** (`modules/EmitterWhitelist`,
     the commented lines above). The constructor stores `emitterAuthorityOf(secret)`, a
     hash of a secret only the publisher holds, and `emitPart` checks that the caller's
     witness secret hashes to it. Uncommented, the snippet above is
     [contracts/emitter.compact](contracts/emitter.compact), the reference emitter.
   - **Commit/reveal per message** (`modules/MessageRegistry`, used by
     [examples/consumer](examples/consumer)). First, in an earlier transaction, commit:
     `registerMessage<N>` checks that the message's parts (private inputs) hash to the
     request ID and stores the request ID with the hash of the owner's secret. Then send
     the message: every part checks that the caller is that owner. Finally, delete the
     commit: `releaseMessage`, after every part.

     ```compact
     import "modules/MessageRegistry";
     export { messageOwnerOf, messageOwner };

     export circuit register3(requestId: Bytes<32>, tails: Vector<3, Bytes<224>>): [] {
       registerMessage<3>(requestId, tails);   // commit, in an earlier transaction
     }
     export circuit emitPart(requestId: Bytes<32>, payload: Bytes<224>): [] {
       assertMessageOwner(requestId);          // only the committed owner
       emitPartEvent(requestId, payload);
     }
     export circuit release(requestId: Bytes<32>): [] {
       releaseMessage(requestId);              // delete the commit, after every part
     }
     ```

   Commit/reveal exists for contracts where several users can emit. A transaction stays
   mergeable after it is sealed (proven, signed and bound; local ledger tests show such
   merges apply), so without it a stranger can add a conflicting part for your request ID
   to your transaction before it lands. The commit must be its own, earlier transaction:
   in the same transaction as the parts, the message is visible in the mempool and a
   stranger can register it first. See [Security considerations](#security-considerations).

3. **Build.** From a fresh clone, with Node 24 (24.21.0 or later) and its npm:

   ```sh
   npm ci                    # the pinned dependencies, from package-lock.json
   npm run build             # the library and the cmse CLI
   npm run cmse -- --help
   ```

   That is enough for `verify`. Deploying and publishing also need the compiled contracts
   and their proving keys: `npm run compile` (compactc 0.34.0 with `--feature-zkir-v3`,
   skip-zk) and `npm run compile:zk` (keys into `build/zk/`, needs the public parameters
   in `MIDNIGHT_PP`). Without a local compiler, the Docker helpers fetch and verify the
   compiler and the parameters, compile in the pinned Node image and copy the output back:

   ```sh
   scripts/docker/fetch-zk-params.sh
   CMSE_ZK_PARAMS=1 CMSE_EXPORT="contracts/managed examples/consumer/managed build/zk" \
     scripts/docker/run.sh compile 'npm ci && npm run compile:zk'
   ```

4. **Deploy and publish.** For the reference emitter, with a funded wallet, a local proof
   server (`scripts/docker/proof-server.sh up` prints its `127.0.0.1` port) and the
   variables of [.env.example](.env.example):

   ```sh
   npm run cmse -- funding --wallet-cache-file ~/cmse/stagenet.wallet-cache.json   # addresses, balances
   npm run cmse -- deploy --emitter-secret-file ~/cmse/emitter.secret \
     --maintenance-key-file ~/cmse/maintenance.json --out deploy.json
   npm run cmse -- publish --contract <address> --message-file notice.bin \
     --emitter-secret-file ~/cmse/emitter.secret --record-out publication.json
   ```

   Every command that opens a wallet first waits for a **complete** sync: the shielded,
   unshielded and DUST wallets must each reach the highest index the indexer reports and
   stay there for several samples. A first sync downloads every zswap and DUST ledger
   event and can take long; progress is printed every 30 s:

   ```
   wallet sync        shielded 1200/5000, unshielded 3/3, dust 40000/250000 (applied/highest index), elapsed 2 min 30 s
   ```

   After `--sync-timeout-minutes` (`CMSE_SYNC_TIMEOUT_MINUTES`, default 60) the command
   prints `not synced` and exits 1; `funding` then shows no balance rather than a zero.
   `--wallet-cache-file <path>` (`CMSE_WALLET_CACHE_FILE`) keeps the synced state for the
   next run.

   `deploy` creates the emitter secret and the maintenance key in new files and never
   prints them. `publish` builds one aggregate guaranteed-only transaction, proves it,
   lets the wallet pay the fee, writes the finalized public bytes to the record before
   submitting them once, waits for the transaction by its identifiers and verifies it
   from its raw bytes. For your own contract, call the same library functions with your
   generated binding (see [examples/consumer/src/board.ts](examples/consumer/src/board.ts)).

## How to verify

`verify` needs no wallet, proof server or compiler. After `npm ci && npm run build`:

```sh
npm run cmse -- verify --contract <address> --tx <transaction hash> --node https://rpc.stagenet.shielded.tools
```

It reads from the indexer (default: stagenet's), checks three levels and stops at the
first that fails.

### Level 1: the message

The key level: it decides whether there is a message at all. The contract's `Misc`
events of that transaction (paginated; widths restored from the raw ledger events) must
form a complete canonical group: exact names `mip-xxxx[v1]:ppp:nnn`, parts 1..n once
each, consistent count and length, canonical padding, and SHA-256 of the ordered tails
equal to the request ID. The message is rebuilt. Events with other names are ignored.

### Level 2: the placement

From the raw finalized transaction bytes: every part is a call to the contract's
`emitPart` with a guaranteed transcript and no fallible one, in one transaction the chain
included (`SUCCESS` or `PARTIAL_SUCCESS`); intents others merged in are ignored. The
groups must equal Level 1's. With `--node`, the raw bytes must also occur in the node's
copy of the block, so that part no longer rests on the indexer.

### Level 3: the code

The verifier key the contract stores for `emitPart` equals the repository's committed
key, which `scripts/keys.sh verify` regenerates from source (`--kind consumer` checks the
consumer's key; `--verifier-key <file>` any other).

Exit status: 0 verified to the requested level (`--level`, default 3); 1 a level failed;
2 usage or input error; 3 not found (not indexed yet, or wrong hash or address).
`--json` prints the report (run it as `npm run -s cmse -- …` so npm's own two-line header
stays off stdout); `--raw-file <hex file> --status SUCCESS` checks saved bytes offline.
Proofs are not re-verified: inclusion on chain means the network verified them.

## How it works

**Event.** Each call emits `Misc { name, payload }`, 32 + 256 bytes:

| Region  | Bytes   | Value                                                                                   |
| ------- | ------- | --------------------------------------------------------------------------------------- |
| name    | 0..12   | ASCII `mip-xxxx[v1]:`                                                                   |
| name    | 13..19  | copy of tail bytes 0..6 (`ppp:nnn`)                                                     |
| name    | 20..31  | zero                                                                                    |
| payload | 0..31   | request ID                                                                              |
| payload | 32..255 | the 224-byte tail                                                                       |
| tail    | 0..6    | ASCII `ppp:nnn`: part and total, three digits each, 1-based, `001 <= ppp <= nnn <= 999` |
| tail    | 7       | zero                                                                                    |
| tail    | 8..15   | message length `L`, uint64 little-endian                                                |
| tail    | 16..223 | message bytes `[(ppp-1)*208, ppp*208)`, zero-padded after `L`                           |

`nnn = max(1, ceil(L / 208))`; every tail repeats `nnn` and `L`. `requestId =
SHA-256(tail_001 || ... || tail_nnn)` over the full tails, which equals Compact's
`persistentHash<Vector<n, Bytes<224>>>`. The circuit copies tail bytes 0..7 into the
name, so the name can never disagree with the hashed tail. It does not hash, split or
check completeness; the reader does ([vectors/v1.json](vectors/v1.json) holds golden
encodings derived independently in Python, `vectors/derive.py`).

**One transaction.** The client executes every part against one pinned block and
contract state, then partitions all calls together with the ledger's
`Transaction.addCalls({ tag: "guaranteedOnly" }, ...)`. The guaranteed phase is
all-or-nothing: if one part fails, the transaction is rejected before inclusion and no
event exists. Executing parts from one pre-state is valid because `emitPart` only reads
access-control state the publication does not change, then emits.

**Checks.** Before proving, after proving, after balancing and after a serialization
round trip, the client requires its own intent to hold exactly the expected calls, in
order, each guaranteed-only and emitting exactly the expected bytes. It submits exactly
the saved bytes.

**Merges.** Anyone who sees the finalized bytes before inclusion can merge in intents of
their own (sealing freezes the intents present, not the set). That cannot alter or
remove our calls, and with an access control nobody else can emit parts for the
contract, so verification looks only at the expected contract's calls. Publications
are tracked by transaction identifiers and the intent hash, not by the transaction hash,
which a merge changes.

## Live on stagenet

> **Pending.** This section is filled in from the live run's evidence. Until then, no
> value below is a live result; placeholders are written `<pending>`.

|                                  | Reference emitter (whitelist)                          | Consumer board (registration) |
| -------------------------------- | ------------------------------------------------------ | ----------------------------- |
| Contract address                 | `<pending>`                                            | `<pending>`                   |
| Deploy transaction, block        | `<pending>`                                            | `<pending>`                   |
| Registration transaction, block  | not applicable                                         | `<pending>`                   |
| Publication transactions, blocks | `<pending>`                                            | `<pending>`                   |
| Message sizes and part counts    | `<pending>`                                            | `<pending>`                   |
| Event ids                        | `<pending>`                                            | `<pending>`                   |
| Indexer                          | https://indexer.stagenet.shielded.tools/api/v4/graphql | same                          |

Evidence manifest: `evidence/stagenet/manifest.json` (`<pending>`). Re-check any
publication, with no wallet:

```sh
npm run cmse -- verify --contract <address> --tx <publication transaction hash> \
  --node https://rpc.stagenet.shielded.tools
```

## What to expect

Measured with real proofs (proof server 9.0.0-rc.6, 2 workers, 4 concurrent requests) and
`LedgerParameters.initialParameters()`; stagenet's live parameters differ (larger block
limits, other prices), and the live figures are `<pending>`:

| Parts | Message bytes | Prove              | Proven transaction | Block usage | Fee (DUST) |
| ----- | ------------- | ------------------ | ------------------ | ----------- | ---------- |
| 1     | 208           | 10.2 s             | 6,264 B            | 0.031       | 0.40       |
| 2     | 399           | 13.9 s             | 12,134 B           | 0.060       | 0.75       |
| 3     | 624           | 19.0 s             | 18,041 B           | 0.090       | 1.10       |
| 8     | 1,647         | 40.9 s             | 47,477 B           | 0.237       | 2.85       |
| 33    | 6,864         | 155.6 s (finalize) | 194,801 B          | 0.974       |            |

About 5.4 KB and 0.029 of a block per part; 34 parts exceed a block and are refused
after proving, before the wallet is asked. The default cap is 8 parts (`--max-parts`).
Circuit sizes from `zkir-v3 mock-compile` (provisional; another compiler will give final
values): reference `emitPart` k=17, 86,450 rows; registry `emitPart` k=17, 86,473;
`registerMessage<N>` about 7,100 rows per part (N=1 k=14, N=3 k=15, N=5 k=16, k=19 from
about N=37).

## How to test

Everything runs in Docker. No wallet, network account or live transaction is involved.

1. **Have Docker and network access.** The first run downloads the pinned images, the npm
   packages, the Compact 0.34.0 release and the public parameters from
   `https://srs.midnight.network/`, each verified against a pinned digest or checksum
   (`CMSE_ZK_PARAMS_DIR=<dir>` reuses a local copy of the parameters).

2. **Run the checks.**

   ```sh
   scripts/check.sh
   ```

3. **Read the result.** The run ends with `all checks passed in <n> s` (about 2 minutes
   warm, most of it key regeneration). On the way it prints one `-- <step>: ok` line per
   step:
   - golden vectors, re-derived independently in Python;
   - `npm ci` from `package-lock.json`, and one copy of each pinned ledger/runtime package;
   - compile (4 contracts), then every key regenerated and compared with the committed
     hashes;
   - format, lint, typecheck, build;
   - tests: `304 passed | 9 skipped` (the skipped ones are opt-in);
   - codec entry point: it loads only Node built-ins;
   - external consumer: the example installed from `npm pack` as a separate project;
   - labels: the naming policy over the full Git history.

4. **Check a clean clone.** The same sequence on a fresh clone of the committed HEAD,
   with empty Docker volumes:

   ```sh
   scripts/check.sh --fresh-clone
   ```

5. **Optional: real proofs.** `tests/real-proof.test.ts` proves publications of 1, 2, 3
   and 8 parts and a merge with a local proof server (several minutes):

   ```sh
   scripts/docker/fetch-zk-params.sh
   scripts/docker/proof-server.sh up
   CMSE_ZK_PARAMS=1 CMSE_DOCKER_NETWORK=cmse-net \
     CMSE_DOCKER_ENV="-e PROOF_SERVER_URL=http://cmse-proof-server:6300 -e ZK_ARTIFACTS_DIR=build/zk/emitter" \
     scripts/docker/run.sh real-proof 'npm ci && npm run compile:zk -- emitter && npm run test:real-proof'
   scripts/docker/proof-server.sh down
   ```

6. **Clean up.** Every Docker resource the checks create is named and labelled with the
   prefix `cmse` (or `$CMSE_DOCKER_PREFIX`). This removes that prefix's resources and
   those of its `--fresh-clone` run, leaves every other prefix alone, and lists what
   remains:

   ```sh
   scripts/docker/teardown.sh
   ```

## Repository layout

```
contracts/modules/MultiSegmentEmit.compact   the event format: emitPartEvent(requestId, payload)
contracts/modules/EmitterWhitelist.compact   example access control: one emitter
contracts/modules/MessageRegistry.compact    example access control: per-message owners (registerMessage<N>)
contracts/emitter.compact, contracts/keys/   reference emitter and its committed verifier key + SHA256SUMS
src/codec/                                   writer, strict reader, width restoration, raw-transaction verifier
src/transaction/                             injected binding, aggregate assembly, stage checks, deploy, single calls
src/adapters/                                indexer, proof server, wallet (complete sync, state cache), zk artifacts, secret files
src/cli/                                     cmse: funding, deploy, deploy-consumer, register, publish, verify
examples/consumer/                           a second contract and client using the public entry points
tests/, vectors/                             unit, adversarial, ledger, CLI and consumer tests; golden vectors
scripts/                                     Docker helpers, compile, keys, checks
docs/INTEGRATION.md                          adding the pattern to your own contract
```

## Security considerations

- The access controls are examples. The contract's maintenance authority outranks
  them: its holder can remove every circuit and install new ones, including an
  `emitPart` without the check. `deploy` installs one deployer-held key (threshold 1).
- Who can emit decides what a stranger can do to your publication. Sealing a
  transaction (proving, signing, binding) freezes the intents it holds, not the set of
  intents: until it is included, anyone holding its finalized bytes can merge in an
  intent of their own (local ledger tests show merged sealed transactions apply).
  - An open contract where several users can emit: a stranger can merge a conflicting
    part for your request ID into your transaction, and readers then reject your
    publication. Commit/reveal (`MessageRegistry`) prevents it: only the committed owner
    can emit that message's parts.
  - Registration and parts in one transaction: the parts reveal the message in the
    mempool, and a stranger can register the same request ID in a transaction of their
    own; if it lands first, your whole transaction fails. This race needs no merge.
    Register in an earlier transaction, where the parts stay private inputs.
  - A single-publisher whitelist (`EmitterWhitelist`): nobody else can emit parts for
    the contract, so neither case applies; intents merged in by others are ignored by
    verification.
- The authorized emitter can still emit an incomplete or wrong-hash group; readers reject
  it. The contract does not enforce message validity.
- An access control is only as strong as the secrecy of its witness secret.
- The indexer is trusted for events and state; `--node` removes that trust for the raw
  transaction bytes. Run your own indexer to remove the rest.
- Proof validity is the network's: inclusion on chain means the node verified the proofs.
  What a message means is up to the contract that emits it.

## About this example repository's tooling (not part of the pattern)

These are rules of this repository's CLI and scripts, not of the event format or of
verification; your own tooling may differ.

- Secrets are files referenced by path: mode 0600, outside every Git working tree, never
  printed or written to records. `.env.example` holds paths only. The optional wallet
  cache holds no key but does hold the wallet's private coin data; it follows the same
  rules, is bound to one wallet and network, and a file that is not such a cache is never
  overwritten.
- Witness secrets are private proof inputs, so the proof server sees them. The CLI
  accepts only a loopback proof server unless told otherwise (`--allow-remote-prover`).

## Limitations

- One publication is one transaction; nothing splits a message across transactions. The
  format allows 999 parts, a block about 33 under default parameters.
- The emission circuit must not write state (see How to use).
- Registration circuits grow with N: k=19 from about 37 parts (expected to be much lower
  with the alternative compiler; to be measured once everything is stable and tested).
- Live stagenet results are pending.

## Tested with

Midnight 2.x, ledger v9. Key reproducibility was measured on this toolchain; re-check it
after upgrading.

| Component                           | Version                                 | Note                                                                    |
| ----------------------------------- | --------------------------------------- | ----------------------------------------------------------------------- |
| Compact compiler                    | 0.34.0                                  | with `--feature-zkir-v3` (0.34.0 still defaults to ZKIR v2)             |
| `@midnight-ntwrk/compact-runtime`   | 0.19.0                                  | required by the generated code; forced by npm `overrides`               |
| `@midnightntwrk/ledger-v9`          | 1.0.0-rc.3                              | the ledger of stagenet's node 2.0.0-d9729c13; forced by npm `overrides` |
| `@midnightntwrk/onchain-runtime-v4` | 4.0.0-rc.3                              | forced by npm `overrides`                                               |
| midnight-js                         | 5.0.0-beta.7                            | types, proof provider, zk-config provider                               |
| wallet-sdk-facade                   | 5.0.0-beta.2                            | with its beta.2 sub-wallets                                             |
| Proof server                        | `midnightntwrk/proof-server:9.0.0-rc.6` | carries the DUST keys (version 9) that stagenet's node expects          |
| Indexer                             | GraphQL API v4                          | stagenet's public indexer                                               |
| Node.js and npm                     | 24.21.0 and 11.19.0                     | the pinned `node:24-bookworm-slim` image of the checks                  |
| Python                              | 3.13                                    | golden-vector derivation only                                           |

When stagenet moves to ledger 9.1 rc.4 (DUST key version 10), the upgrade is midnight-js
5.0.0-beta.8, ledger-v9 1.0.0-rc.4, wallet-sdk-facade 5.0.0-beta.3 and proof server
9.0.0-rc.7.

## Acknowledgments

The original idea comes from [SIG Network](https://sig.network). Its SGN1 event protocol
for Midnight carried a request as a sequence of `Misc` events, each holding a 32-byte
request ID followed by a 224-byte tail; the request ID was the SHA-256 of the ordered,
padded tails, and every part was emitted in the transaction's guaranteed section (see
the [archived description](https://github.com/sig-net/midnight-integration/blob/620c550ee2002dbb51955093a04c0060d2985256/events-migration.md)).
This repository keeps those widths and that hash rule and generalizes the pattern to
arbitrary messages. Its event names, metadata layout and access-control examples are its
own, and it claims no compatibility with SIG Network's protocols.

## License

Apache-2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE).
