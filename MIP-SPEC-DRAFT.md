---
MIP: xxxx
Title: Multi-Part Event (`mip-xxxx:multi-part[v1]`)
Authors:
  - Edward Alvarado <edward.alvarado@midnight.foundation>
Status: Draft
Category: Standards
Created: <PR date, YYYY-MM-DD>
Requires: MIP-0002: Public Contract Log Emission for Compact Smart Contracts
Replaces: none
MPS: none
License: Apache-2.0
---

<!--
 Copyright 2026 Midnight Foundation

 Licensed under the Apache License, Version 2.0 (the "License");
 you may not use this file except in compliance with the License.
 You may obtain a copy of the License at

     https://www.apache.org/licenses/LICENSE-2.0

 Unless required by applicable law or agreed to in writing, software
 distributed under the License is distributed on an "AS IS" BASIS,
 WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 See the License for the specific language governing permissions and
 limitations under the License.
-->

## Drafting notes (remove before submitting)

- **State:** OUTLINE: titles, subtitles and key points only; no prose yet. Created 2026-09-24.
- **Target:** a PR to [midnightntwrk/midnight-improvement-proposals](https://github.com/midnightntwrk/midnight-improvement-proposals) adding `mips/mip-xxxx-multi-part-event.md` with status Draft.
- **Sources:**
  - the "Spec" section of this repository's [README](README.md), as of `ba9710b`;
  - the maintainers' approved specification and research notes on placement and indexer filtering (not in this repository);
  - the MIP repository at [`a3e664a`](https://github.com/midnightntwrk/midnight-improvement-proposals/tree/a3e664aadf1b76124354aba4f56ec01651a95291): `mips/mip-template.md`, MIP-0001, MIP-0002 and MIP-0018, the style model.
- **Why this MIP:** MIP-0018 §5.4 leaves multipart values to a follow-up. This MIP is that follow-up, for any event.

### Format rules of the MIP repository

- **File:** `mips/mip-xxxx-<slug>.md`. MIP-0001 says `mip-xxxx.md`, but MIP-0018's draft `mip-xxxx-on-chain-token-metadata.md` was accepted. Images go in `mips/mip-xxxx/`; none are needed.
- **Structure:** YAML front matter, then the Apache-2.0 comment. The template's headings are mandatory, in order; appendices go after the Copyright Waiver.
- **Versioning:** MIP-0001 requires a versioning scheme (here §9 of the Specification).
- **Code:** none in the PR; link the repository at a pinned commit.
- **Commits:** signed (verified) and authored by the human author; no AI author or co-author.
- **Process:**
  1. Draft PR; assign and mention an editor to number it.
  2. Merged as Draft; discussion in GitHub Discussions.
  3. An issue proposes it; at least two weeks of comments; editor vote.
- **After numbering:** `mip-xxxx` becomes the number throughout the text, as PR #325 did for MIP-0018.

### Defaults chosen (change if needed)

- **Category:** Standards, a convention like MIP-0018.
- **MPS:** none. MPS-0005 covers events but not their size.
- **Verification (§7):** SHOULD, not MUST.

### D1: two rules that are not in the approved spec (RESOLVED)

The outline added two rules that the approved spec does not have:

1. An event name already emitted without the rule opts in only under a new version of that name (§1).
2. Readers roll back packages from blocks a reorganization removes, or read finalized blocks only (§6).

**Question:** should the MIP add them as normative rules?

**Use cases:**

- MIP-0018's `emitStandardFields` emits three `mip-0018:token-metadata[v1]` events (name, symbol, decimals) in one call, so in one intent. If MIP-0018 opted that name in, the three declarations would merge into one 768-byte package. MIP-0018 v1 requires exactly 256 bytes and rejects it: all three are lost, and past events change meaning silently.
- A reader following the chain tip records a package from block B, then a reorganization drops B. Without rule 2 the reader keeps a package that the canonical chain does not hold.

| OPTION                     | PROS                                                                                                                             | CONS                                                  |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Add both                   | Closes two gaps an editor would likely raise; both follow from the current rules; MIP-0018 §6.2 has the same reorganization rule | Two more normative rules                              |
| Only the name-version rule | Prevents the silent change of meaning                                                                                            | Reorganization handling stays unstated                |
| Neither                    | Matches the approved spec exactly                                                                                                | Opting in an old name silently merges its past events |

**Recommendation:** add both.

**Resolution (owner):**

- **Rule 2: RESOLVED, added** (2026-09-24, "yes"). §6 states it without the "New" label.
- **Rule 1: RESOLVED, no rule** (2026-09-25, "lets just put in the warnings", after the explanation below). The MIP states no rule; informative warnings sit in §1, the Backwards Compatibility Assessment and Appendix B.

#### Rule 1 explained

- **No start date:** the opt-in lives in P's specification, not on chain. A reader that applies the rule to N applies it to every N event, including those emitted before P opted in.
- **The effect:** if an old intent holds two separate N events from one contract, the reader now joins them into one package, so past events change meaning.
- **Example:** MIP-0018's `emitStandardFields` emits three separate `mip-0018:token-metadata[v1]` events (name, symbol, decimals) in one call.
  - Today a reader sees three declarations.
  - After an opt-in of that name, readers would join them into one 768-byte payload. MIP-0018 accepts exactly 256 bytes, so it rejects it.
  - Every token published that way loses its name, symbol and decimals, retroactively.
- **The rule:** a protocol opts a name in before its first use. A protocol that already emits `…[v1]` opts in `…[v2]`: old `[v1]` events keep their meaning, `[v2]` events are packages, and readers tell them apart by name.
- **The exception it gives up:** a name that never had two events from one contract in one intent could opt in safely, since a single event is a package of one. Proving that means checking every past intent and every deployed circuit, and `emitStandardFields` could still be called after the opt-in.

**Question:** which form of rule 1 should the MIP state?

| OPTION                                                                                          | PROS                                                        | CONS                                                                                                                     |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| New name or version only                                                                        | One sentence; always safe; readers need no dates or history | A protocol with deployed contracts must change its emitting circuit to emit the new name, even when its history is clean |
| Old name allowed if no past intent and no deployed circuit puts two of its events in one intent | No circuit change when that holds                           | P must check every past intent and every deployed circuit, and readers must trust that check                             |
| Leave it out                                                                                    | Matches the approved spec                                   | The MIP-0018 case breaks silently; an editor will likely ask                                                             |

**Recommendation:** new name or version only. New protocols, such as SIG Network's and the repository's two examples, meet it without doing anything.

### Citations to add in the full draft

Ledger tag `ledger-9.1.0.0-rc.3`; line numbers from the maintainers' research notes.

- **Intents keyed by segment, 0 never an intent:** `ledger/src/structure.rs:1659-1675`, `ledger/src/verify.rs:544-546`.
- **Merge collision refused:** `structure.rs:1487-1511`, `error.rs:1020-1024`.
- **The seal covers the segment and the contents:** `structure.rs:918-957`, `verify.rs:565`.
- **Execution order:** `semantics.rs:1344-1363`, `1066-1212` and `147-190`; `structure.rs:1827-1837`.
- **`EventSource`:** `semantics.rs:1127-1133` and `1230-1235`.
- **Node admission runs the guaranteed phase only:** midnight-node `node-2.0.0-rc.4`, `ledger/src/versions/guaranteed_validation/ledger_9.rs:14-35`.
- **JS `successfulSegments` inverted:** `ledger-wasm/src/tx.rs:1893-1906`; midnight-ledger#760.

## Abstract

<!-- about 200 words -->

- A MIP-0002 `Misc` event carries a 32-byte name and a 256-byte payload. There is no standard way to publish a larger message.
- This MIP defines `mip-xxxx:multi-part[v1]`, an opt-in processing rule, not an event. A protocol states in its own specification that its event name N follows the rule.
- Then all N events that one contract emits in one intent of one included transaction form one package. Their payloads are concatenated in emission order and processed as one normal N event.
- The ledger supplies the package boundary and the order: the intent seal, the all-or-nothing guaranteed section, and the event's `physical_segment`. No framing bytes, no hash, no registration.
- Nothing new on chain: no event name, field or byte, and no ledger, compiler, indexer or node change. A reference implementation is live on Stagenet.

## Motivation

### The problem

- `Misc { name: Bytes<32>, payload: Bytes<256> }` (MIP-0002 Appendix A); events are capped at 1 KB (MIP-0002 "Schema Sizing").
- Messages larger than 256 bytes exist:
  - cross-chain signature requests that carry a serialized foreign transaction (SIG Network, where this rule comes from);
  - MIP-0018 values over 189 bytes (its §5.4 leaves multipart to a follow-up);
  - documents and attestations.

### Why not chunking per protocol

- Every protocol would reinvent the framing (a request ID, "part i of n", a hash), and readers would diverge.
- Each framing needs its own argument against a third party injecting, dropping or reordering parts.

### Why not contract state or a larger event

- Contract state is permanent, grows what every node keeps, and needs the contract's layout to read. Events are not consensus state (MIP-0002 "Event Lifetime").
- A larger payload or a new `LogEventType` needs a ledger release and a hard fork. This rule works today and stays valid if the limit grows: a larger single event is a package of one.

### Why no framing is needed

- After sealing, an intent's calls cannot be added, removed, changed or moved.
- The guaranteed section applies all or nothing, and every event records the intent that emitted it.
- So the chain already draws the package boundary and fixes the order.

## Specification

- Opens with the RFC 2119 sentence, in MIP-0018's wording.

### Scope

- **Normative:** §1 to §7 and §9.
- **Informative:** the ledger guarantees, §8 Limits, the appendices and the reference implementation.
- A protocol that does not opt in is not affected; this MIP requires nothing of it.

### Terminology

- **Adopting protocol (P):** a protocol whose specification opts its event name N into this rule.
- **Event name (N):** the 32-byte `Misc` name that P's contracts emit, for example `mip-9931:cool-beans[v1]`.
- **Part:** one event named N: a 32-byte name and a 256-byte payload.
- **Package:** all parts from one contract in one intent of one included transaction, in emission order.
- **Intent, physical segment:** an intent is keyed by its segment number in the transaction; events report that number as `physical_segment`.
- **Guaranteed section:** the phase that applies every intent's guaranteed transcripts first. Its failure fails the whole transaction.
- **Publisher:** the party that builds and submits the transaction.
- **Reader:** the party that turns events into packages.

### Ledger guarantees relied on (informative)

Midnight ledger 9.1, as on Stagenet:

- **The intent map:** a transaction holds its intents in a map from segment number to intent. Segment 0 is the guaranteed section and never holds an intent. Merging two transactions whose intents share a segment number is refused.
- **The seal:** an intent's seal covers its segment number and all its contents, every contract call included. After sealing nobody can add, remove, change or move a call; a merge can only add other intents at other segment numbers.
- **Execution order:** the ledger applies all guaranteed calls first (intents in ascending segment order, calls in sealed order), then each fallible segment in ascending order. A guaranteed failure fails the whole transaction, which is not included. So a guaranteed package lands whole, in order, or not at all.
- **`EventSource`:** every event carries `EventSource { transaction_hash, logical_segment, physical_segment }`. `physical_segment` identifies the intent; `logical_segment` is always 0.
- **`Misc` widths:** a `Misc` event is a 32-byte name and a 256-byte payload. The ledger trims trailing zero bytes of the logged value, so readers restore both widths.

### 1. Opting in

- P's specification states that N follows `mip-xxxx:multi-part[v1]` (short: `mip-xxxx`). The opt-in is per event name.
- The rule defines no event name, field or byte on chain. Which (contract, N) pairs opted in is known from P's specification, not from the chain.
- Events of protocols that did not opt in are untouched.
- **Warning (informative):** the opt-in is not on chain and has no start date, so readers apply the rule to every N event, including those emitted before P opted in. If a past intent holds two separate N events from one contract, opting N in changes their meaning.
  - Example: MIP-0018's reference `emitStandardFields` emits three `mip-0018:token-metadata[v1]` events (name, symbol, decimals) in one call. If that name were opted in, readers would join them into one 768-byte payload, which MIP-0018 rejects (it accepts exactly 256 bytes).
  - A new name, or a new version of the name (for example `[v2]`), avoids this.

### 2. Packages (rule 1: grouping)

- All events named N that one contract emitted from one intent (one physical segment) of one included transaction form one package, in their emission order.
- After inclusion a package is identified by (network, contract address, N, transaction hash, physical segment).
- Before inclusion the publisher tracks it by the intent's hash. A merge changes the transaction hash, never the segment or the intent.

### 3. Merged payload (rule 2)

- The package's payload is the concatenation of its events' 256-byte payloads.
- A single event is a package of one part, so opting in changes nothing for single events.

### 4. Processing (rule 3)

- The merged payload is processed exactly as P processes the payload of a normal N event.
- P's payload format MUST be readable at any multiple of 256 bytes. P carries its own length, type or checksum if it needs one.

### 5. Publisher obligations (rule 4)

- Publishers put all parts of one logical N event in one intent, all guaranteed, in order.
- P never emits two independent N events from one contract in one intent: they would be merged into one.
- A package split over two intents reads as two packages, so publishers MUST NOT split one.

### 6. Reader requirements

For each (contract, N) that P's specification opted in, a reader:

- takes only that contract's `Misc` events whose name, restored to 32 bytes, is exactly N, and restores each payload to 256 bytes;
- groups them by (network, contract, N, transaction hash, physical segment); the segment comes from `EventSource` or from the intent's key in the raw transaction;
- orders each group by the call order in the sealed intent, or by event IDs that follow ledger emission order, never by delivery order;
- accepts an identical redelivery of one event, and rejects a package in which one event arrives with two contents;
- fetches every event of an intent before merging. The indexer has no name filter: page through the contract's `Misc` events, at most 500 per page;
- bounds its input (events per package, packages) and never interprets the merged payload;
- rolls back packages from blocks a reorganization removes, or reads finalized blocks only.

### 7. Verification (SHOULD)

- **Level 1, the package:** §6.
- **Level 2, the placement,** from the raw transaction:
  - every call of the emitting circuit in that intent is guaranteed-only;
  - the events equal the calls' emitted values, in order;
  - the transaction is included, and a node's block holds the same raw bytes.
- **Level 3, the code:** the emitting circuit's deployed verifier key, at the package's block, equals the key built from P's published source.
- An indexer response alone is not proof. Inclusion means the network verified the proofs.
- **Per-segment results:** use the indexer's `transactionResult.segments`. The ledger-v9 JavaScript `TransactionResult.successfulSegments` is inverted (`true` means failed) until ledger 10 (midnight-ledger#760).

### 8. Limits (informative)

- Block size is the binding limit: each part adds one call and its proof, about 5.9 KB.
- Measured with real proofs of the reference `emitPart` (k = 16, 41,546 rows, provisional), before the wallet adds its fee intent:
  - 169 parts fit a block under Stagenet's parameters;
  - 33 fit under the ledger's default parameters.
- Each part is an ordinary `Misc` event, so MIP-0002's per-event limit is unaffected.

### 9. Versioning

- The version is in the rule's name: `mip-xxxx:multi-part[v1]`.
- An incompatible change (for example a fallible placement mode) is a `[v2]` amendment or a new MIP. P names the version it follows.
- P's own event name keeps its own versioning, independent of this rule.
- The rule puts no bytes on chain, so assigning the MIP number changes only text. No deployed contract or event changes, unlike MIP-0018, whose event name carries its number.

### Out of scope

- P's payload format: length, type, checksum, compression and encryption.
- Fallible placement, and packages that span intents or transactions.
- Discovering opt-ins from the chain, or any registry.
- Indexer support for filtering `Misc` events by name.

## Rationale

### Why a processing rule and not a new event?

- Adopters keep their own event name, filters and versioning.
- There is nothing to register or deploy, and a single event keeps its meaning.

### Why is the intent the package boundary?

- The seal fixes an intent's calls and their order.
- A merge cannot add a call to it and refuses a taken segment number.
- Each event names its intent.

### Why no ID, part number, count or hash?

- Sealed order plus all-or-nothing application make them redundant.
- A commit/reveal step would add a transaction and protect nothing the seal does not. P may still carry a checksum.

### Why guaranteed only?

- A failed fallible segment is rolled back while the transaction is still included and paid.
- Parts split between guaranteed and fallible placement can land half a package, and readers would need per-segment results.
- Left to a later version.

### Why is the size the adopter's?

- One definition of length, in P's format, instead of two that can disagree.

### Why not a larger `Misc` payload or a new `LogEventType`?

- Either needs a ledger release and a hard fork. This rule composes with either if it comes later.

### Alternatives considered

- Explicit framing (ID, index, count, hash); commit/reveal; contract state; one package per transaction; fallible placement; compression.
- Generic alternatives only; no history of earlier drafts.

## Path to Active

### Acceptance Criteria

- At least one protocol opts in in its specification and publishes packages on a public network.
- At least one reader other than the reference implementation (an indexer, explorer, SDK or MPC) applies the rule and passes the reader cases of Testing.
- The reference implementation is public at a pinned commit.
- Community review through the MIP process.

### Implementation Plan

- **Done:** the reference library and `cmse verify`, CI, and both examples live on Stagenet (`acedward/compact-multi-segment-emit` @ `ba9710b`).
- **Next:**
  - a first adopter (SIG Network's events are the natural candidate);
  - Preprod, when events reach it;
  - reader support proposed to the SDK and explorers;
  - optionally, a `Misc` name filter in the indexer.

## Backwards Compatibility Assessment

- No ledger, compiler, indexer or node change, and no hard fork.
- Protocols that do not opt in are untouched, and single events keep their meaning.
- **Warning:** opting in a name already in use can change the meaning of its past events, as the MIP-0018 example in §1 shows. A new name or version avoids it.
- A reader that ignores the rule sees k separate events. P's specification is what obliges P's readers to apply it.

## Security Considerations

### Authorship

- The seal gives a package integrity, not identity. Authorship comes from the emitting contract's access control, not from this rule.
- On an open contract anyone can publish a package in an intent of their own, even inside your transaction.

### Third-party merges

- A merger cannot touch your intent. At most it adds its own package at another segment number, and a taken number is refused.

### Maintenance authority

- A contract's maintenance authority outranks its access control: it can replace the emitting circuit.
- Readers who trust a contract's packages also trust that authority. Level 3 shows the key at the package's block.

### Split, partial and misplaced packages

- A split package reads as two packages; P's length or checksum detects it.
- Fallible or mixed placement fails Level 2.

### Untrusted payloads and resource bounds

- Every payload byte is attacker-controlled.
- Readers bound events per package and the number of packages, and P's decoder validates the merged payload.

### Indexer trust and completeness

- A reader that uses an indexer trusts it for the events and the state. Level 2 checks the raw transaction against a node's block.
- A missing page is a missing part: fetch the whole intent. The raw transaction shows how many parts to expect.

### Replay

- The ledger refuses an intent it has already included. Publishing the same payload again is a new intent and a new package; deduplication is P's.

### Disclosure and proving

- Everything emitted is public (MIP-0002).
- A proof server sees every witness, an access-control secret included, so prove locally.

## Implementation

- No Midnight component changes; only publishers and readers implement the rule.

### Reference implementation

- `acedward/compact-multi-segment-emit` @ `ba9710b` (Apache-2.0):
  - `reader`: group, order, merge, placement check;
  - `publisher`: split into parts, one intent per package, checks before and after proving;
  - `indexer`: the public-indexer client;
  - `cmse verify`: Levels 1 to 3.
- Examples: an access control (`EmitterWhitelist`), the reference emitter (`example:message[v1]`) and a second adopter (`notice-board:notice[v1]`).
- Linked, not copied: no code in the PR.

### Reference deployment (Stagenet)

- Both examples are deployed. Packages of 1 and 4 parts, a repeat, and one transaction holding two packages are all verified at Level 3 against a node.
- Addresses and the live example stay in the repository README, so a redeployment never leaves stale data in the MIP (MIP-0018 does the same).

### Dependencies

- MIP-0002 `Misc` events.
- Compact 0.34.0, runtime 0.19.0, Midnight ledger 9 (as on Stagenet).

## Testing

- **Reader cases:**
  - a stranger's intent in my transaction;
  - two of my packages in one transaction;
  - out-of-order and redelivered events, and one event with two contents;
  - names or contracts that did not opt in;
  - width restoration;
  - split and fallible placement;
  - input bounds.
- **Ledger-application cases:** a failing part leaves nothing and the transaction is not included; a segment collision on merge is refused.
- **Live:** every Stagenet package verified at Level 3 from a fresh clone; CI runs the checks on every push.
- **No byte test vectors:** the rule defines no encoding, so these cases are the conformance suite.

## References

- MIP-0001, MIP-0002 and MIP-0018; MPS-0005.
- RFC 2119.
- midnight-ledger at tag `ledger-9.1.0.0-rc.3` (the cited source lines); midnight-ledger#760.
- The reference implementation.
- SIG Network (https://sig.network).

## Acknowledgements

- SIG Network, for the use case and the idea.
- Dominik Zajkowski, for MIP-0002.
- Reviewers.

## Copyright Waiver

- The standard text, as in MIP-0018.

## Appendix A: Worked example (informative)

- A 700-byte message with P's own 2-byte length prefix is 702 bytes, so 3 parts, the last zero-padded.
- One intent with three calls: the three events share one `physical_segment`. The merged payload is 768 bytes; P reads its length and keeps 700.
- A stranger's intent in the same transaction, emitting N from the same open contract, has another `physical_segment`, so it is another package.

## Appendix B: Adopter checklist (informative)

- The opt-in sentence for P's specification, for example: "Events named `mip-9931:cool-beans[v1]` follow `mip-xxxx:multi-part[v1]`."
- Opting in a name already in use: see the warning in §1.
- A minimal emitting circuit: the reference `emitPart`.
- P's format carries a length, and a checksum if needed.
- The emitting circuit has access control.
- One logical event per intent, all parts guaranteed.

## Appendix C: Measured limits (informative)

- Parts per block under Stagenet's and the ledger's default parameters, the size of one part, K and rows; all marked provisional.
