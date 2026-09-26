---
MIP: "xxxx"
Title: Multi-Part Event (`mip-xxxx:multi-part[v1]`)
Authors:
  - Edward Alvarado <edward.alvarado@midnight.foundation>
Status: Draft
Category: Standards
Created: TBD (date of the upstream pull request)
Requires: MIP-0002
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

## Abstract

This proposal defines an opt-in rule for transporting a longer public payload in several `Misc` contract events, each with a 32-byte name and a 256-byte payload. After exact contract and event-name filtering, a reader groups all matching applied events from one physical intent of one included transaction and concatenates their payloads in ledger emission order.

The physical intent supplies the package boundary. No part number, count, identifier, checksum, registry, or persistent state is added on chain. Publishers are encouraged to emit a package in the guaranteed phase, but a package emitted entirely in one fallible phase is also atomic: on success all of its events are applied, and on failure none are. All events that form one package must use the same execution phase because a fallible failure can otherwise leave only the package's guaranteed portion applied.

## Motivation

One `Misc` payload is too small for some serialized transactions, attestations, and documents. Defining a new framing format for every protocol would duplicate part numbers, counts, identifiers, and integrity checks. Contract state would make assembly persistent and contract-specific, while increasing the event size would require a Midnight capability change.

Midnight transactions already provide an intent boundary and a deterministic order for applied contract events. This proposal standardizes how an adopting protocol uses that boundary without changing the ledger.

## Specification

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**, and **MAY** in this document are to be interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) and [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174) when, and only when, they appear in all capitals.

### 1. Scope and terminology

An **adopting protocol** opts an event name into this rule. A **publisher** emits the events. A **reader** reconstructs their **transport package**. A **part** is the 256-byte payload of one matching applied `Misc` event. A transport package is the ordered concatenation of one or more parts.

### 2. Opting in

The chain and contract address come from the deployed contract instance. The adopting protocol MUST declare:

1. **Event name:** the exact value of the existing `Misc` `name` field, shared by every part.
2. **Multipart rule:** the protocol's specification MUST state that it follows `mip-xxxx:multi-part[v1]`.

This rule begins only after exact contract and event-name filtering of valid, decoded, applied events. If a protocol has not made that opt-in, this proposal has no effect on its events. Invalid envelopes, unsupported decoders, incomplete API responses, conflicting upstream deliveries, and unavailable history are outside this rule's input boundary.

For every nonempty group in scope, the only result defined here is an accepted transport package. This proposal does not define an application schema, application validity, authorization, signatures, truth, or semantic replay policy. An adopting protocol may consume arbitrary bytes and need not define any of those concepts.

### 3. Reconstructing packages

For a deployed contract instance and an opted-in event name, matching events from the same included transaction and the same physical intent form one group. Each nonempty group produces one package. A reader MUST follow ledger emission order, take each event's full 256-byte payload exactly once, and concatenate the payloads in that order. It MUST preserve every byte, including trailing zeros.

Events from different chains, contract addresses, event names, physical intents, or included transactions MUST NOT be joined, even when their caller or payload bytes are equal. Zero matching events produce no package. One matching event produces a one-part package. Several events that a publisher intended as separate messages still produce one package when they are in the same group; this rule carries no hidden sub-boundary. The package length is 256 times its number of events, and the original unpadded application length cannot be recovered from this transport alone.

### 4. Publisher requirements and atomicity

All matching events that a publisher places in the same physical intent share the same physical segment number within the transaction and would form one package when applied, even if the publisher regards them as separate logical messages. The publisher MUST place all of those events in one execution phase. It MUST preserve the intended byte order when it emits them. The parts MAY be produced by one call or several calls, and a call MAY emit more than one matching event.

A publisher SHOULD use the guaranteed phase. Guaranteed placement avoids a fallible execution failure that produces no package. Guaranteed placement is a recommendation, not a condition for this transport rule.

A publisher MAY instead place all of those events in the fallible phase of the physical intent. If that phase succeeds, all of its events are applied. If it fails, its state changes and locally accumulated events are discarded, so the reader receives no matching applied event and produces no package. The caller MUST verify that the transaction was included on chain and that this fallible phase succeeded before treating the package as published.

A publisher MUST NOT split those events between the guaranteed and fallible phases. The ledger applies guaranteed events before fallible segments. If the fallible phase then fails, its events are discarded while the guaranteed events may remain applied in a partially successful transaction. A reader still groups the matching events that were actually applied; it does not infer an unemitted part or introduce another result for the publisher's mistake.

Canonical-chain and reorganization handling remain part of the underlying event processing. This proposal assumes its input contains valid, decoded, applied events with known ledger emission order; it does not claim that an arbitrary endpoint is honest, available, complete, or permanently retaining history.

## Rationale

The physical intent is the smallest existing boundary that resists a third party adding calls during transaction composition. Using it avoids a new on-chain package identifier. The prerequisite already defines event access and order, so repeating those mechanisms here would create two specifications for the same event stream.

Guaranteed placement is recommended because the whole guaranteed phase applies or produces no applied events. It is not mandatory because one fallible segment is also internally atomic: success returns its state and events, while failure returns neither. The important publisher rule is that every event in one package stays within one of those atomic phases. A mixed-phase package loses that property, even if the publisher regarded its events as separate messages.

Explicit framing could support message boundaries within one intent or across intents, but it would add part indexes, counts, identifiers, and parser rules. Contract state would provide persistent assembly at the cost of state growth. A larger event would require a platform change. Those are different designs; this proposal intentionally uses the boundary the ledger already supplies.

## Path to Active

This document is a Draft and makes no claim of Acceptance, Implementation, or network activation.

### Acceptance Criteria

Before this proposal can be considered Active:

1. MIP editors assign its number and accept the normative rule through the MIP process;
2. at least two independently implemented readers reproduce every normative vector below;
3. guaranteed and fallible-only publications are exercised against an implementation of the prerequisite, including a failed fallible phase with no applied parts;
4. a public activation record identifies the exact chain, implementation, and observation artifacts; and
5. no unresolved security or interoperability issue changes the specified behavior.

### Implementation Plan

Publish the vectors with a small reference reader, update the existing reference publisher and reader to the accepted text, test another independent reader, and record activation only after the specified phase behavior and public-network examples are reproduced. Failures keep the proposal at its current stage until the specification or implementation is corrected.

## Backwards Compatibility Assessment

This proposal changes no ledger, VM, node, compiler, contract event, or indexer API. Protocols that do not opt in are unaffected. A one-part package has the same 256 payload bytes as the original event. Older readers continue to expose separate events; readers for an adopting protocol combine them first.

An opt-in has no inherent start height. Applying it to an event name already in use reinterprets all matching history. If one old intent contains several independent events with that name, the rule combines them. A new event name avoids this ambiguity. This proposal warns about the risk but does not forbid retroactive opt-in.

## Security Considerations

Transaction composition cannot add calls to an already sealed physical intent; a colliding physical segment is refused. A composer may add another intent, which forms a separate package.

A publisher can still publish false or misleading bytes, place two intended messages in one package, or split a message across different intents or transactions. It can also place matching events for one package across execution phases, contrary to the publisher rule. This transport convention does not establish truth, authorship, authorization, or an application-level boundary. The package-level phase rule prevents a fallible failure from leaving only the guaranteed prefix of one transport package.

Every part and package is public. The contract, name, transaction, intent, payload length, bytes, timing, and frequency may be visible to ledger readers, nodes, indexers, wallets, frontends, and proof services. Application encryption may hide payload plaintext but does not hide that metadata or retract disclosed data.

Repeated equal bytes in a new intent or transaction form a new package. The transport defines no semantic replay handling. Consumers must also respect the chain and reorganization policy of their event processing. Passing malformed or incomplete upstream data into this algorithm violates its input premise; this proposal does not add a second acquisition or endpoint-security protocol.

## Implementation

No Midnight component change is required. A candidate reference implementation is available in [`acedward/compact-multi-part-event`](https://github.com/acedward/compact-multi-part-event). It provides publisher and reader libraries, contract examples, a CLI, and tests. The implementation intentionally uses guaranteed-only publication and its raw placement verifier enforces that narrower profile. Its raw-transcript decoder can enumerate both guaranteed and fallible logs. These components and the public examples are implementation evidence, not the normative definition.

On 2026-09-25, the reference implementation was exercised on Stagenet with genesis `0x2f76825abc239fecf6107c9df99016de57037b451ae57a4394b76c8cf53a9491`. The fresh contract was `27a8be750856ace6276eef6be2e456947c395364ae08f6cf2c1ace5dd319a2c8` and its event name was `example:message[v1]`.

Transaction `3a4c54e93bb80ecc7574738e06fd82ef7f8ff3265a6bddc350c225bd92fafcdd` in block 618048 carried two guaranteed-only packages. Segment 5392 reconstructed one 256-byte part with SHA-256 `40aff2e9d2d8922e47afd4648e6967497158785fbd1da870e7110266bf944880`. Segment 45345 reconstructed three parts and 768 bytes with SHA-256 `f5d7cc3852a3ae6f9948a8a84062358c722e2c0415e1490615b2fa4185023ebf`. Those 768 bytes were exactly a 700-byte input, including its 17 trailing zero bytes, followed by 68 padding zero bytes. Transaction `dacd193039b14f8833a17c7964923de2c95dd18eaec5dcd62ac5166772553074` in block 618059 published the same 256 bytes in a new intent and produced a separate package.

A wallet-free reader reproduced the bytes from the public indexer and found the raw transactions in the stated RPC blocks. At `2026-09-25T15:18:02Z`, RPC finalized height 618100 exceeded the inclusion heights and its hashes at the tested heights matched the indexer. Both services use the `shielded.tools` domain, so this is provider-trusted corroboration rather than an independent consensus or light-client proof.

The live run did not test fallible-only or mixed-phase publication, multiple matching events from one call, third-party composition, reorganization, or retroactive opt-in. That Stagenet run therefore supplies no evidence for fallible-only or mixed-phase behavior.

## Testing

The following vectors are normative. They start after opt-in and exact contract and event-name filtering. Inputs are valid, decoded, applied events with their ledger emission order; a row may list them in a different delivery order to test normalization. `x*n` means `n` copies of octet `x`, and `||` means concatenation:

```
A = aa*256
B = bb*255 || 00
C = cc*256
Z = 00*256
```

Unless stated otherwise, events use one chain, contract, name, transaction `T1`, and physical intent 7.

| Case | Applied matching events | Required transport result |
| --- | --- | --- |
| Empty filtered input | none | no package |
| All-zero part | `Z` | one part, payload `Z`, length 256 |
| Trailing zero | `B` | one part, payload `B`; keep its final zero |
| Guaranteed multipart | guaranteed `A`, then guaranteed `B` | one package, payload `A \|\| B`, length 512 |
| Fallible success | fallible `C`, then fallible `B`, both applied | one package, payload `C \|\| B`, length 512 |
| Fallible failure | no applied matching event from the failed phase | no package |
| Same-group separate intentions | guaranteed `A` intended as message 1, then applied fallible `B` intended as message 2 | one package, payload `A \|\| B`; publisher violated the package-level single-phase requirement |
| Mixed-phase failure | guaranteed `A`; fallible `B` was discarded and is absent | one package, payload `A`; publisher violated the package-level single-phase requirement and the reader does not infer `B` |
| Upstream order | events delivered to the model as `B`, `A`, with ledger order `1`, `0` | one package, payload `A \|\| B` |
| Equal distinct events | `A`, then `A` at two event positions | two parts, payload `A \|\| A` |
| Multiple logs per call | one call emits `A`, then `C` | two parts, payload `A \|\| C` |
| Two intents | intent 7 emits `A`; intent 8 emits `B` | two packages; never join them |
| Repeated publication | `(T1, intent 7)` and `(T2, intent 7)` each emit `A` | two packages despite equal bytes |
| No hidden framing | `A` and `C` were intended as separate messages in one intent | one package, payload `A \|\| C` |

The machine-readable corpus and independent model used while drafting are maintained with the proposal evidence. The model only groups already-applied events and checks exact bytes; it does not execute platform state transitions or prove fallible atomicity. A conforming reader MUST reproduce these package groups, part counts, part orders, lengths, and bytes. A publisher implementation MUST test the phase it supports. An implementation that supports fallible publication MUST also test fallible success, fallible failure, and the mixed-phase counterexample against its supported event implementation.

## References (Optional)

- [MIP process](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mips/mip-0001-mip-process.md)
- [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119)
- [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174)

## Acknowledgements

The multipart use case originated in work on SIG Network. Dominik Zajkowski authored the public-event proposal on which this proposal depends.

## Copyright Waiver

All code and text contributed through this proposal are to be licensed under the Apache License, Version 2.0. The operative Contributor License Agreement text and link are editor-owned publication metadata and remain to be supplied by the MIP repository before submission.
