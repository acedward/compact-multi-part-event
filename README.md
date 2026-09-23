# Compact multi-segment event emission

Work in progress. This repository will define and implement a pattern for
publishing one runtime-sized message as several fixed-size Compact `Misc`
events, emitted by repeated guaranteed calls to one circuit inside one Midnight
transaction, together with an independent reader and a raw-transaction
verifier.

The complete README (specification, rationale, reproduction and integration
steps) is written in a later step. Until then, nothing in this repository is a
released or deployed result.
