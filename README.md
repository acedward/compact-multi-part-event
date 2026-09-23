# Compact multi-segment event emission

Publish a message of any size through Midnight contract events. The client splits the
message into 224-byte tails and calls one small circuit, `emitPart(requestId, payload)`,
once per tail, all in one guaranteed transaction. Each call emits one `Misc` event; a
reader accepts the message only when every part of it was emitted by the expected
contract in one included transaction and the parts hash to the request ID. Nothing is
stored in contract state.

Targets Midnight 2.x (ledger 9) with Compact 0.34.0. The event-name prefix
`mip-xxxx[v1]:` uses `mip-xxxx` as an unassigned placeholder, not an assigned number.

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

   Uncommented, this is [contracts/emitter.compact](contracts/emitter.compact), the
   reference emitter. For a contract where several users publish, use
   `modules/MessageRegistry` instead: each message is registered by its owner in an
   earlier transaction (`registerMessage<N>`, exported for the sizes you need) and only
   the owner can emit its parts. Keep the emission circuit free of state writes: every
   part of a publication is executed from the same pre-state.

2. **Build.** `npm run compile` (Docker: `scripts/docker/run.sh compile 'npm ci && npm run compile'`)
   compiles with compactc 0.34.0 and `--feature-zkir-v3`; `npm run compile:zk` also
   generates the proving keys into `build/zk/`. `npm run build` compiles the library and the `cmse` CLI
   (`npm run cmse -- --help`).

3. **Deploy and publish.** For the reference emitter, with a funded wallet, a local proof
   server and the variables of [.env.example](.env.example):

   ```sh
   npm run cmse -- funding --wallet-cache-file ~/cmse/stagenet.wallet-cache.json   # addresses, balances
   npm run cmse -- deploy --emitter-secret-file ~/cmse/emitter.secret \
     --maintenance-key-file ~/cmse/maintenance.json --out deploy.json
   npm run cmse -- publish --contract <address> --message-file notice.bin \
     --emitter-secret-file ~/cmse/emitter.secret --record-out publication.json
   ```

   Every command that opens a wallet first waits for a **complete** sync: the shielded,
   unshielded and DUST wallets must each have applied everything up to the highest index
   the indexer reports, and stay there for several samples. The first sync of a wallet
   downloads every zswap and DUST ledger event of the chain and can take a long time; it
   prints a progress line every 30 s with each wallet's applied and highest index and the
   elapsed time, for example:

   ```
   wallet sync        shielded 1200/5000, unshielded 3/3, dust 40000/250000 (applied/highest index), elapsed 2 min 30 s
   ```

   The wait is bounded by `--sync-timeout-minutes` (`CMSE_SYNC_TIMEOUT_MINUTES`, default
   60); when the sync does not complete, the command prints `not synced` with the
   progress and exits 1, and `funding` shows no balance at all rather than a zero.
   `--wallet-cache-file <path>` (`CMSE_WALLET_CACHE_FILE`) saves the synced wallet state
   and restores it on the next run, so later syncs only fetch what is new; the file holds
   private wallet data (no keys), so it gets the secret-file rules (mode 0600, outside
   every Git working tree).

   `deploy` creates the emitter secret and the maintenance key in new files (mode 0600,
   outside every Git working tree) and never prints them. `publish` builds one
   aggregate guaranteed-only transaction, proves it, lets the wallet pay the fee, writes
   the finalized public bytes to the record before submitting them once, waits for the
   transaction by its identifiers and verifies it from its raw bytes. For your own
   contract, call the same library functions with your generated binding (see
   [examples/consumer/src/board.ts](examples/consumer/src/board.ts)).

## How to verify

`verify` needs no wallet, proof server or compiler: `npm ci && npm run build`, then

```sh
npm run cmse -- verify --contract <address> --tx <transaction hash> --node https://rpc.stagenet.shielded.tools
```

It reads from the indexer (default: stagenet's) and stops at the first failing level.

**Level 1, the message.** The contract's `Misc` events of that transaction (paginated;
widths restored from the raw ledger events) form a complete canonical group: exact
names `mip-xxxx[v1]:ppp:nnn`, parts 1..n once each, consistent count and length,
canonical padding, and SHA-256 of the ordered tails equal to the request ID. The
message is rebuilt. Events with other names are ignored.

**Level 2, the placement.** From the raw finalized transaction bytes: every part is a
call to the contract's `emitPart` with a guaranteed transcript and no fallible one, in
one transaction the chain included (`SUCCESS` or `PARTIAL_SUCCESS`); intents others
merged in are ignored. The groups must equal Level 1's. With `--node`, the raw bytes must
also occur in the node's copy of the block, so that part no longer rests on the indexer.

**Level 3, the code.** The verifier key the contract stores for `emitPart` equals the
repository's committed key, which `scripts/keys.sh verify` regenerates from source
(`--kind consumer` checks the consumer's key; `--verifier-key <file>` any other).

Exit status: 0 verified to the requested level (`--level`, default 3); 1 a level failed;
2 usage or input error; 3 not found (not indexed yet, or wrong hash or address).
`--json` prints the report; `--raw-file <hex> --status SUCCESS` checks saved bytes offline.
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

> **Pending.** This section is filled in by the live run. Until then, no value below is a
> live result; placeholders are written `<pending>`.

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

Secret-free, everything in Docker, no wallet or network account:

```sh
scripts/check.sh            # install, compile, keys, lint, types, build, tests, entry points, labels
scripts/check.sh --fresh-clone   # the same from a clean clone of the committed HEAD
```

`scripts/check.sh` runs `npm ci`, `node scripts/check-pins.mjs`, `npm run compile`,
`scripts/keys.sh verify all` (regenerates every key and compares the committed hashes),
`scripts/derive-vectors.sh --check`, Prettier, ESLint, `tsc`, `npm run build`, `npm test`,
`npm run check:entrypoints`, `scripts/check-external-consumer.sh` and
`scripts/check-labels.sh --history`, and ends with `all checks passed`. It needs Docker, and network access for the first package install and for the public parameters, which are fetched from `https://srs.midnight.network/` and checked against pinned SHA-256 values (or copied from a local cache named by `CMSE_ZK_PARAMS_DIR`). A warm run takes about 100 s, most of it key regeneration. Remove its Docker volumes with `scripts/docker/teardown.sh`. The real-proof
tests (`tests/real-proof.test.ts`) are opt-in: start `scripts/docker/proof-server.sh up`
and set `PROOF_SERVER_URL` and `ZK_ARTIFACTS_DIR`.

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
- The pattern assumes one user builds and emits each publication. A contract that lets
  several users emit needs the per-message registration, and the registration must be
  its own, earlier transaction: in the same transaction the tails are visible in the
  mempool before it lands.
- The authorized emitter can still emit an incomplete or wrong-hash group; readers reject
  it. The contract does not enforce message validity.
- Witness secrets are private proof inputs, so the proof server sees them. The CLI
  accepts only a loopback proof server unless told otherwise (`--allow-remote-prover`).
- Secrets are files referenced by path: mode 0600, outside every Git working tree, never
  printed or written to records. `.env.example` holds paths only. The optional wallet
  cache holds no key but does hold the wallet's private coin data; it follows the same
  rules, is bound to one wallet and network, and a file that is not such a cache is never
  overwritten.
- The indexer is trusted for events and state; `--node` removes that trust for the raw
  transaction bytes. Run your own indexer to remove the rest.
- Proof validity is the network's: inclusion on chain means the node verified the proofs.
  What a message means is up to the contract that emits it.

## Limitations

- One publication is one transaction; nothing splits a message across transactions. The
  format allows 999 parts, a block about 33 under default parameters.
- The emission circuit must not write state (see How to use).
- Registration circuits grow with N (k=19 from about 37 parts).
- Live stagenet results are pending.

## Compatibility

Midnight 2.x, ledger 9. Tested with compactc 0.34.0 (`--feature-zkir-v3`),
`@midnight-ntwrk/compact-runtime` 0.19.0, `@midnightntwrk/ledger-v9` 1.0.0-rc.3 (the
ledger of stagenet's node 2.0.0-d9729c13), midnight-js 5.0.0-beta.7, wallet-sdk-facade
5.0.0-beta.2, proof server 9.0.0-rc.6, the indexer's GraphQL v4 API, Node 24.21.0 and npm
11.19.0. When stagenet moves to ledger 9.1 rc.4 (DUST key version 10), the upgrade is
midnight-js 5.0.0-beta.8, ledger-v9 1.0.0-rc.4, wallet-sdk-facade 5.0.0-beta.3 and proof
server 9.0.0-rc.7.

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
