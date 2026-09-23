// P3 evidence tool: the live one-block fit (FR-006) from saved finalized publications.
//
// usage: node scripts/p3/live-limit.mjs <ledger-parameters.hex> <record.json>...
//
// Each record is a `cmse publish --record-out` file (submitted or --dry-run). For every
// record the finalized transaction bytes are deserialized and their cost is recomputed
// under the given (live) ledger parameters with time-to-dismiss enforced, then
// normalized to the block limits. A least-squares line per dimension over the part
// counts gives the per-part and fixed cost; the fit is the largest part count whose
// every dimension, and whose size, stays within one block and the transaction size
// limit. Public data only.
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";

import * as ledger from "@midnightntwrk/ledger-v9";

const [parametersFile, ...recordFiles] = process.argv.slice(2);
if (parametersFile === undefined || recordFiles.length < 2) {
  console.error(
    "usage: node scripts/p3/live-limit.mjs <parameters.hex> <record.json> <record.json>...",
  );
  process.exit(2);
}
const hexBytes = (hex) => Uint8Array.from(Buffer.from(hex.trim(), "hex"));
const parameters = ledger.LedgerParameters.deserialize(
  hexBytes(readFileSync(parametersFile, "utf8")),
);
// The JS API exposes no field for the transaction size limit; read it from the
// parameters' own debug rendering.
const byteLimitMatch = /transaction_byte_limit: (\d+)/u.exec(parameters.toString(false));
if (byteLimitMatch === null) throw new Error("no transaction_byte_limit in the parameters");
const byteLimit = Number(byteLimitMatch[1]);

const points = recordFiles.map((file) => {
  const saved = JSON.parse(readFileSync(file, "utf8"));
  const record = saved.record ?? saved;
  const bytes = hexBytes(record.transactionHex);
  const tx = ledger.Transaction.deserialize("signature", "proof", "binding", bytes);
  const normalized = parameters.normalizeFullness(tx.cost(parameters, true));
  return {
    file,
    parts: record.tailsHex.length,
    bytes: bytes.length,
    recorded: saved.normalizedCost,
    recomputed: { ...normalized },
  };
});

const fit = (xs, ys) => {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i += 1) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
  }
  const slope = sxy / sxx;
  return { perPart: slope, fixed: my - slope * mx };
};

const xs = points.map((point) => point.parts);
const dimensions = Object.keys(points[0].recomputed);
const perDimension = {};
let fitParts = Number.POSITIVE_INFINITY;
let binding;
for (const dimension of dimensions) {
  const line = fit(
    xs,
    points.map((point) => point.recomputed[dimension]),
  );
  const parts = line.perPart > 0 ? Math.floor((1 - line.fixed) / line.perPart) : null;
  perDimension[dimension] = { ...line, fitParts: parts };
  if (parts !== null && parts < fitParts) {
    fitParts = parts;
    binding = dimension;
  }
}
const size = fit(
  xs,
  points.map((point) => point.bytes),
);
const sizeParts = Math.floor((byteLimit - size.fixed) / size.perPart);
if (sizeParts < fitParts) {
  fitParts = sizeParts;
  binding = "transaction_byte_limit";
}

console.log(
  JSON.stringify(
    {
      parameters: parametersFile,
      points,
      perDimension,
      size: { ...size, limitBytes: byteLimit, fitParts: sizeParts },
      computedLiveFitParts: fitParts,
      binding,
    },
    null,
    2,
  ),
);
