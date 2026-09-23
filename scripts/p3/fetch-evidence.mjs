// P3 evidence tool: fetch the public record of one included transaction and save it.
//
// usage: node scripts/p3/fetch-evidence.mjs --tx <hash> --out <dir> [--contract <address>]
//          [--indexer <graphql url>] [--node <rpc url>] [--wait-final <seconds>]
//
// Writes (public data only):
//   <out>/transactions/<hash>.hex    the indexer's raw transaction bytes (hex)
//   <out>/transactions/<hash>.json   status, segments, identifiers, fees, block, contract
//                                    actions, raw SHA-256, the node's block cross-check and
//                                    the finalized head observed
//   <out>/events/<hash>.json         with --contract: every Misc event of that contract in
//                                    the transaction (id, name/payload/raw hex; paginated)
// Names are kept as hex on purpose (the event names are ASCII).
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { IndexerClient, rawTransactionInBlock } from "../../dist/adapters/indexer.js";

const args = new Map();
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 2) args.set(argv[index], argv[index + 1]);
const tx = (args.get("--tx") ?? "").replace(/^0x/u, "").toLowerCase();
const out = args.get("--out");
const contract = args.get("--contract")?.toLowerCase();
const indexerUrl =
  args.get("--indexer") ?? "https://indexer.stagenet.shielded.tools/api/v4/graphql";
const nodeUrl = args.get("--node") ?? "https://rpc.stagenet.shielded.tools";
const waitFinalSeconds = Number(args.get("--wait-final") ?? "0");
if (!/^[0-9a-f]{64}$/u.test(tx) || out === undefined) {
  console.error("usage: fetch-evidence.mjs --tx <hash> --out <dir> [--contract <address>] ...");
  process.exit(2);
}

const indexer = new IndexerClient({ url: indexerUrl });
const sha256 = (hex) => createHash("sha256").update(Buffer.from(hex, "hex")).digest("hex");

const rpc = async (method, params) => {
  const response = await globalThis.fetch(nodeUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: globalThis.AbortSignal.timeout(30_000),
  });
  const body = await response.json();
  if (body.error !== undefined) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
};

const finalizedHead = async () => {
  const hash = await rpc("chain_getFinalizedHead", []);
  const header = await rpc("chain_getHeader", [hash]);
  return { number: Number.parseInt(header.number, 16), hash: hash.replace(/^0x/u, "") };
};

const data = await indexer.query(
  `query ($hash: HexEncoded!) {
    transactions(offset: { hash: $hash }) {
      __typename hash raw block { height hash timestamp }
      ... on RegularTransaction {
        identifiers fee fees { paidFees estimatedFees }
        transactionResult { status segments { id success } }
        contractActions { __typename address ... on ContractCall { entryPoint } }
      }
    }
  }`,
  { hash: tx },
);
const [found] = data.transactions;
if (found === undefined) {
  console.error(`transaction ${tx} not found on the indexer`);
  process.exit(3);
}
const { raw, ...rest } = found;
const extrinsicIndex = await rawTransactionInBlock(nodeUrl, found.block.hash, raw);

let head = await finalizedHead();
const waitStarted = Date.now();
while (head.number < found.block.height && Date.now() - waitStarted < waitFinalSeconds * 1000) {
  await sleep(3000);
  head = await finalizedHead();
}

const record = {
  fetchedAt: new Date().toISOString(),
  indexer: indexerUrl,
  node: nodeUrl,
  ...rest,
  block: { ...found.block, timestampIso: new Date(found.block.timestamp).toISOString() },
  rawBytes: raw.length / 2,
  rawSha256: sha256(raw),
  nodeCrossCheck: {
    method: "chain_getBlock",
    extrinsicIndex: extrinsicIndex ?? null,
    rawBytesFoundInBlock: extrinsicIndex !== undefined,
  },
  finality: {
    finalizedHead: head,
    finalized: head.number >= found.block.height,
    observedAt: new Date().toISOString(),
  },
};
mkdirSync(join(out, "transactions"), { recursive: true });
writeFileSync(join(out, "transactions", `${tx}.hex`), `${raw}\n`);
writeFileSync(join(out, "transactions", `${tx}.json`), `${JSON.stringify(record, null, 2)}\n`);

let events;
if (contract !== undefined) {
  events = await indexer.miscEvents(contract, { transactionHash: tx });
  mkdirSync(join(out, "events"), { recursive: true });
  writeFileSync(
    join(out, "events", `${tx}.json`),
    `${JSON.stringify({ contract, transactionHash: tx, count: events.length, events }, null, 2)}\n`,
  );
}

console.log(
  JSON.stringify(
    {
      hash: found.hash,
      status: found.transactionResult?.status ?? null,
      block: record.block,
      fees: found.fees ?? null,
      rawBytes: record.rawBytes,
      extrinsicIndex: record.nodeCrossCheck.extrinsicIndex,
      finality: record.finality,
      events: events?.map((event) => event.id) ?? null,
    },
    null,
    2,
  ),
);
