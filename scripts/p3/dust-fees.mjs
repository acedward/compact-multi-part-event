// P3 evidence tool: the DUST each saved transaction actually declares as fee (the sum of
// its DUST spends' `vFee`), next to the fee the ledger requires under given parameters.
//
// usage: node scripts/p3/dust-fees.mjs <ledger-parameters.hex> <transaction.hex>...
//
// The indexer's `fees { paidFees }` reports the required fee; the wallet (facade
// 5.0.0-beta.2) declares more, the required fee times `maxPriceAdjustment` to the power
// of its `feeBlocksMargin` (100 in the P3 run, the CLI's default 5 since S1.10), and
// the DUST a transaction consumes is the declared fee. Public data only.
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

import * as ledger from "@midnightntwrk/ledger-v9";

const [parametersFile, ...files] = process.argv.slice(2);
if (parametersFile === undefined || files.length === 0) {
  console.error("usage: node scripts/p3/dust-fees.mjs <parameters.hex> <transaction.hex>...");
  process.exit(2);
}
const hexBytes = (text) => Uint8Array.from(Buffer.from(text.trim(), "hex"));
const parameters = ledger.LedgerParameters.deserialize(
  hexBytes(readFileSync(parametersFile, "utf8")),
);
const SPECK_PER_DUST = 10n ** 15n;
const dust = (speck) =>
  `${(speck / SPECK_PER_DUST).toString()}.${(speck % SPECK_PER_DUST).toString().padStart(15, "0")}`;

const rows = files.map((file) => {
  const tx = ledger.Transaction.deserialize(
    "signature",
    "proof",
    "binding",
    hexBytes(readFileSync(file, "utf8")),
  );
  let declared = 0n;
  const spends = [];
  for (const [segment, intent] of tx.intents ?? []) {
    for (const spend of intent.dustActions?.spends ?? []) {
      declared += spend.vFee;
      spends.push({ segment, vFee: spend.vFee.toString() });
    }
  }
  const required = tx.fees(parameters, true);
  return {
    transaction: basename(file, ".hex"),
    dustSpends: spends,
    declaredFeeSpeck: declared.toString(),
    declaredFeeDust: dust(declared),
    requiredFeeSpeckAtTheseParameters: required.toString(),
    requiredFeeDust: dust(required),
    ratio: Number(declared) / Number(required),
  };
});
const total = rows.reduce((sum, row) => sum + BigInt(row.declaredFeeSpeck), 0n);
console.log(
  JSON.stringify(
    {
      parameters: parametersFile,
      rows,
      totalDeclaredSpeck: total.toString(),
      totalDeclaredDust: dust(total),
    },
    null,
    2,
  ),
);
