# Consumer example: a notice board

A second contract that reuses the pattern from outside the library, the way an
integrator would. Several users publish long notices on one board; each notice is
registered by its owner first, so nobody else can emit its parts.

- [`contracts/consumer.compact`](contracts/consumer.compact) imports the shared modules
  `MultiSegmentEmit` (event format) and `MessageRegistry` (per-message registration),
  exports `register1`, `register2`, `register3` and `register5`, `emitPart`, and keeps
  application state of its own (`announcements`, `latestAnnouncement`, written by the
  separate `announce` circuit).
- [`keys/`](keys) holds the committed verifier keys and the `SHA256SUMS` of every
  generated artifact (`scripts/keys.sh verify consumer` regenerates and compares them).
- [`src/board.ts`](src/board.ts) binds the library's composer to this contract's own
  generated binding; [`src/offline-demo.ts`](src/offline-demo.ts) runs the whole flow on a
  local ledger: deploy, two owners register in their own transactions, each publishes
  one aggregate guaranteed-only transaction, the public reader rebuilds both notices from
  the events and from the raw transactions, then `announce` and `release` run later.

The sources import the library only by its package name (`compact-multi-segment-emit/...`).
`scripts/check-external-consumer.sh` packs the library, installs it into a copy of this
directory as a separate project, compiles it with [`tsconfig.build.json`](tsconfig.build.json)
and runs the demo.

Order of transactions for one notice: `register<N>` (the message stays a private input),
then all `emitPart` calls in ONE transaction, then optionally `announce` and `release`.
Registration and parts must not share a transaction: the parts reveal the message in
the mempool before the registration lands. `announce` and `release` write state, so they
are never batched with the parts, which all execute from the same pre-state.
