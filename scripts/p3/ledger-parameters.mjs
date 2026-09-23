// P3 evidence tool: decode a block's serialized ledger parameters (hex, as the indexer's
// `block { ledgerParameters }` returns it) with the pinned ledger-v9 and write the
// readable form next to it.
//
// usage: node scripts/p3/ledger-parameters.mjs <parameters.hex> [<out.txt>]
// Prints the byte length, the SHA-256 of the bytes, and the block limits the one-block
// fit is measured against. Public data only.
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

import * as ledger from "@midnightntwrk/ledger-v9";

const [input, output] = process.argv.slice(2);
if (input === undefined) {
  console.error("usage: node scripts/p3/ledger-parameters.mjs <parameters.hex> [<out.txt>]");
  process.exit(2);
}
const hex = readFileSync(input, "utf8").trim().toLowerCase();
const bytes = Uint8Array.from(Buffer.from(hex, "hex"));
const parameters = ledger.LedgerParameters.deserialize(bytes);
const text = parameters.toString(false);
if (output !== undefined) writeFileSync(output, `${text}\n`);
console.log(
  JSON.stringify(
    {
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      roundTrip: Buffer.from(parameters.serialize()).toString("hex") === hex,
      maxPriceAdjustment: parameters.maxPriceAdjustment(),
    },
    null,
    2,
  ),
);
