/**
 * `cmse verify` through `main()` against a served fake indexer and node over the
 * in-process ledger, and offline from saved bytes:
 *
 * - Levels 1-3 with the node cross-check (exit 0); `--json`; `--example` presets;
 * - a transaction holding two packages (two intents) gives two packages; `--segment`;
 * - listing every package of a (contract, name) from the contract's events (no `--tx`);
 * - failures (exit 1): a different committed key (Level 3), a missing part in the
 *   events (Level 2 count mismatch), a whole intent missing from the events (Level 1),
 *   typed fields that disagree with the raw events (Level 1), a node block without the
 *   bytes (Level 2), a non-inclusion status (offline);
 * - not found (exit 3): unknown transaction, another contract, another name, an empty
 *   listing; usage errors (exit 2); `--help`;
 * - the shared CLI plumbing: repeatable flags, flags given twice, exit after flush.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EXAMPLES, main } from "../src/cli/main.js";
import { exitAfterFlush, parseArgs, UsageError } from "../src/cli/options.js";
import type { VerifyReport } from "../src/cli/verify.js";
import { buildPackagesTransaction, splitPayload } from "../src/publisher/index.js";
import { concatBytes, filled32, patternMessage, toHex } from "./helpers/bytes.js";
import { FakeIndexer, type IndexedEntry } from "./helpers/fake-indexer.js";
import { EMITTER_VERIFIER_KEY, EXAMPLE_NAME, repoFile } from "./helpers/generated.js";
import {
  configFor,
  deployEmitter,
  emitterBinding,
  LocalChain,
  NETWORK,
  requestFor,
} from "./helpers/ledger.js";

const outDir = mkdtempSync(join(tmpdir(), "cmse-verify-"));
const secret = filled32(7);
const ONE = patternMessage(700);
const TWO_A = patternMessage(300, 1);
const TWO_B = patternMessage(40, 2);

let chain: LocalChain;
let fake: FakeIndexer;
let emitter: string;
let other: string;
let one: IndexedEntry;
let two: IndexedEntry;
let served: { indexerUrl: string; nodeUrl: string; close(): Promise<void> };
let wrongNode: { url: string; close(): Promise<void> };

const publish = async (
  contract: string,
  payloads: readonly Uint8Array[],
): Promise<IndexedEntry> => {
  const built = await buildPackagesTransaction(
    chain.source(),
    configFor(),
    payloads.map((payload) => requestFor(contract, emitterBinding(secret), splitPayload(payload))),
  );
  return fake.include(built.transaction.eraseProofs());
};

beforeAll(async () => {
  chain = new LocalChain();
  fake = new FakeIndexer(chain);
  emitter = await deployEmitter(chain, secret);
  other = await deployEmitter(chain, filled32(9));
  one = await publish(emitter, [ONE]);
  two = await publish(emitter, [TWO_A, TWO_B]);
  served = await fake.serve();
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { block: { extrinsics: ["0x00"] } } }),
    );
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  wrongNode = {
    url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/rpc`,
    close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
  };
});

afterAll(async () => {
  await served.close();
  await wrongNode.close();
});

const run = async (argv: string[]): Promise<{ status: number; out: string; err: string }> => {
  const out: string[] = [];
  const err: string[] = [];
  const status = await main(
    argv,
    {},
    { out: (line) => out.push(line), err: (line) => err.push(line) },
  );
  return { status, out: out.join("\n"), err: err.join("\n") };
};

const online = (contract = emitter) => [
  "verify",
  "--network",
  NETWORK,
  "--indexer",
  served.indexerUrl,
  "--contract",
  contract,
  "--name",
  EXAMPLE_NAME,
];

const keyFile = (() => {
  const path = join(tmpdir(), `cmse-verify-key-${String(process.pid)}.verifier`);
  writeFileSync(path, EMITTER_VERIFIER_KEY);
  return path;
})();

const sha256 = async (bytes: Uint8Array): Promise<string> =>
  (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex");

describe("verify one transaction", () => {
  it("verifies levels 1-3 with the node cross-check (exit 0)", async () => {
    const result = await run([
      ...online(),
      "--tx",
      one.hash,
      "--node",
      served.nodeUrl,
      "--verifier-key",
      keyFile,
    ]);
    expect(result.err).toBe("");
    expect(result.status).toBe(0);
    expect(result.out).toContain(
      `L1 OK   3 part(s), 768 bytes, payload SHA-256 ${await sha256(concatBytes(splitPayload(ONE)))}`,
    );
    expect(result.out).toContain("L2 OK   included, status SUCCESS");
    expect(result.out).toMatch(
      /L2 OK {3}every emitPart call in the intent at segment \d+ is guaranteed-only and logs these 3 part\(s\), in order/,
    );
    expect(result.out).toMatch(/L2 OK {3}the node's block \d+ holds the raw bytes \(extrinsic 1\)/);
    expect(result.out).toMatch(
      /L3 OK {3}the deployed emitPart verifier key at block \d+ equals the expected one \(SHA-256 b25a6c6a565fde435afeacbae73434a9db2730f871e53da589395a27144842d7\)/,
    );
    expect(result.out).toContain("result      1 package(s); verified to level 3 of 3");
  });

  it("a transaction with two packages (two intents) gives two packages; --segment picks one", async () => {
    const all = await run([...online(), "--tx", two.hash, "--verifier-key", keyFile, "--json"]);
    expect(all.status).toBe(0);
    const report = JSON.parse(all.out) as VerifyReport;
    expect(report.packages).toHaveLength(2);
    const payloads = report.packages.map((pkg) => pkg.payloadHex).sort();
    expect(payloads).toEqual(
      [toHex(concatBytes(splitPayload(TWO_A))), toHex(concatBytes(splitPayload(TWO_B)))].sort(),
    );
    expect(new Set(report.packages.map((pkg) => pkg.segment)).size).toBe(2);
    expect(report.packages.every((pkg) => pkg.level === 3)).toBe(true);
    const segment = report.packages[1]?.segment ?? 0;
    const picked = await run([
      ...online(),
      "--tx",
      two.hash,
      "--segment",
      String(segment),
      "--level",
      "2",
      "--json",
    ]);
    expect(picked.status).toBe(0);
    const narrowed = JSON.parse(picked.out) as VerifyReport;
    expect(narrowed.packages.map((pkg) => pkg.segment)).toEqual([segment]);
    expect(narrowed.level).toBe(2);
  });

  it("--example emitter sets the name and the committed key", async () => {
    const result = await run([
      "verify",
      "--network",
      NETWORK,
      "--indexer",
      served.indexerUrl,
      "--example",
      "emitter",
      "--contract",
      emitter,
      "--tx",
      one.hash,
    ]);
    expect(result.status).toBe(0);
    expect(result.out).toContain("event name  example:message[v1]; emitting circuit emitPart");
    expect(EXAMPLES.emitter?.name).toBe(EXAMPLE_NAME);
    expect(EXAMPLES["notice-board"]?.name).toBe("notice-board:notice[v1]");
  });

  it("fails Level 3 on a different committed key (exit 1)", async () => {
    const path = join(outDir, "other.verifier");
    const key = new Uint8Array(
      readFileSync(repoFile("contract-examples/emitter/keys/emitPart.verifier")),
    );
    key[200] = (key[200] ?? 0) ^ 1;
    writeFileSync(path, key);
    const result = await run([...online(), "--tx", one.hash, "--verifier-key", path]);
    expect(result.status).toBe(1);
    expect(result.out).toMatch(
      /L3 FAIL the deployed emitPart verifier key at block \d+ \(SHA-256 b25a6c6a/,
    );
    expect(result.out).toContain("verified to level 2 of 3");
  });

  it("fails Level 2 when the node's block does not hold the bytes (exit 1)", async () => {
    const result = await run([
      ...online(),
      "--tx",
      one.hash,
      "--level",
      "2",
      "--node",
      wrongNode.url,
    ]);
    expect(result.status).toBe(1);
    expect(result.out).toMatch(/L2 FAIL the node's block \d+ \(\w+\) does not hold these bytes/);
  });

  it("an event missing from the fetch fails Level 2 (count), a missing intent fails Level 1", async () => {
    const ids = await eventIdsOf(one.hash);
    fake.hiddenEvents.add(ids[1] ?? -1);
    try {
      const missingPart = await run([...online(), "--tx", one.hash, "--level", "2"]);
      expect(missingPart.status).toBe(1);
      expect(missingPart.out).toContain("L1 OK   2 part(s), 512 bytes");
      expect(missingPart.out).toContain(
        "L2 FAIL the intent's emitPart calls log 3 parts; the package has 2",
      );
      for (const id of ids) fake.hiddenEvents.add(id);
      const missingIntent = await run([...online(), "--tx", one.hash, "--level", "2"]);
      expect(missingIntent.status).toBe(1);
      expect(missingIntent.out).toContain(
        "L1 FAIL the events lack this package: the raw transaction's intent logs 3 parts named N",
      );
    } finally {
      fake.hiddenEvents.clear();
    }
  });

  it("typed fields that disagree with the raw events fail Level 1 (exit 1)", async () => {
    const corrupt = new FakeIndexer(chain, { corruptTypedName: true });
    corrupt.entries.push(...fake.entries);
    const corruptServed = await corrupt.serve();
    try {
      const result = await run([
        "verify",
        "--network",
        NETWORK,
        "--indexer",
        corruptServed.indexerUrl,
        "--contract",
        emitter,
        "--name",
        EXAMPLE_NAME,
        "--tx",
        one.hash,
        "--level",
        "1",
      ]);
      expect(result.status).toBe(1);
      expect(result.out).toContain("L1 FAIL events of this transaction could not all be read");
      expect(result.out).toContain("typed name/payload disagree with the raw event");
    } finally {
      await corruptServed.close();
    }
  });

  it("reports not found for an unknown transaction, another contract or another name (exit 3)", async () => {
    const unknown = await run([...online(), "--tx", "ab".repeat(32), "--level", "2"]);
    expect(unknown.status).toBe(3);
    expect(unknown.out).toContain("not found: transaction abab");
    const contract = await run([...online(other), "--tx", one.hash, "--level", "2"]);
    expect(contract.status).toBe(3);
    const name = await run([
      ...online().map((arg) => (arg === EXAMPLE_NAME ? "notice-board:notice[v1]" : arg)),
      "--tx",
      one.hash,
      "--level",
      "2",
    ]);
    expect(name.status).toBe(3);
    expect(name.out).toContain("no package of");
  });
});

const eventIdsOf = async (hash: string): Promise<number[]> => {
  const response = await fetch(served.indexerUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query:
        "query ($address: HexEncoded!, $tx: HexEncoded!, $limit: Int!, $offset: Int!) { contractEvents(filter: { contractAddress: $address, transactionHash: $tx, types: [MISC] }, limit: $limit, offset: $offset) { id } }",
      variables: { address: emitter, tx: hash, limit: 500, offset: 0 },
    }),
  });
  const body = (await response.json()) as { data: { contractEvents: { id: number }[] } };
  return body.data.contractEvents.map((event) => event.id);
};

describe("list every package of a (contract, name)", () => {
  it("pages through the contract's events and verifies each package (exit 0)", async () => {
    const result = await run([...online(), "--verifier-key", keyFile, "--json"]);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.out) as VerifyReport;
    expect(report.mode).toBe("listing");
    expect(report.packages).toHaveLength(3);
    expect(report.events).toBe(3 + 2 + 1);
    expect(report.packages.map((pkg) => pkg.transactionHash)).toEqual([
      one.hash,
      two.hash,
      two.hash,
    ]);
    expect(report.level).toBe(3);
  });

  it("lists at Level 1 without raw transactions or keys", async () => {
    const result = await run([...online(), "--level", "1"]);
    expect(result.status).toBe(0);
    expect(result.out.match(/^package /gmu)).toHaveLength(3);
    expect(result.out).not.toContain("L2 ");
  });

  it("an empty listing is not found (exit 3)", async () => {
    const result = await run([...online(other), "--level", "1"]);
    expect(result.status).toBe(3);
    expect(result.out).toContain("among the contract's 0 Misc events");
  });
});

describe("offline, from saved bytes", () => {
  const saved = () => {
    const raw = join(outDir, "raw.hex");
    writeFileSync(raw, `${one.rawHex}\n`);
    const state = join(outDir, "state.bin");
    writeFileSync(
      state,
      fake.snapshots.get(one.blockHash)?.index(emitter)?.serialize() ?? new Uint8Array(),
    );
    return { raw, state };
  };
  const offline = (files: { raw: string }) => [
    "verify",
    "--network",
    NETWORK,
    "--contract",
    emitter,
    "--name",
    EXAMPLE_NAME,
    "--raw-file",
    files.raw,
    "--tx",
    one.hash,
  ];

  it("verifies Levels 1-3 from the raw transaction and the saved state (exit 0)", async () => {
    const files = saved();
    const result = await run([
      ...offline(files),
      "--status",
      "SUCCESS",
      "--state-file",
      files.state,
      "--verifier-key",
      keyFile,
    ]);
    expect(result.status).toBe(0);
    expect(result.out).toContain("source      saved raw transaction");
    expect(result.out).toContain("L1 OK   3 part(s), 768 bytes");
    expect(result.out).toContain("verified to level 3 of 3");
  });

  it("refuses a status that is not an inclusion (exit 1), and Level 3 without a state (exit 2)", async () => {
    const files = saved();
    const failed = await run([...offline(files), "--status", "FAILURE", "--level", "2"]);
    expect(failed.status).toBe(1);
    expect(failed.out).toContain("L2 FAIL status FAILURE is not an inclusion");
    const noState = await run([
      ...offline(files),
      "--status",
      "SUCCESS",
      "--verifier-key",
      keyFile,
    ]);
    expect(noState.status).toBe(2);
    expect(noState.err).toContain("offline Level 3 needs --state-file");
  });
});

describe("usage", () => {
  it.each([
    [[], 2],
    [["--help"], 0],
    [["frobnicate"], 2],
    [["verify", "--bogus"], 2],
    [["verify", "--contract", "12", "--name", "n", "--level", "1"], 2],
    [["verify", "--contract", "ab".repeat(32), "--level", "1"], 2],
    [["verify", "--contract", "ab".repeat(32), "--name", "n", "--level", "4"], 2],
    [["verify", "--contract", "ab".repeat(32), "--name", "n"], 2],
    [["verify", "--contract", "ab".repeat(32), "--name", "x".repeat(33), "--level", "1"], 2],
    [["verify", "--contract", "ab".repeat(32), "--name", "n", "--level", "1", "--segment", "3"], 2],
    [["verify", "--contract", "ab".repeat(32), "--name", "n", "--level", "1", "--example", "x"], 2],
    [["verify", "--contract", "ab".repeat(32), "--name", "n", "--tx", "12", "--level", "1"], 2],
    [
      [
        "verify",
        "--contract",
        "ab".repeat(32),
        "--name",
        "n",
        "--level",
        "1",
        "--status",
        "SUCCESS",
      ],
      2,
    ],
    [
      [
        "verify",
        "--contract",
        "ab".repeat(32),
        "--name",
        "n",
        "--level",
        "1",
        "--raw-file",
        "/nonexistent",
      ],
      2,
    ],
  ])("%j exits %i", async (argv, expected) => {
    const result = await run(argv);
    expect(result.status).toBe(expected);
    if (expected === 2 && argv.length > 0) expect(result.err).toMatch(/^error: /);
  });

  it("--help documents the levels, the exit statuses, every flag and variable", async () => {
    const result = await run(["--help"]);
    for (const text of [
      "--contract",
      "--name",
      "--entry-point",
      "--example",
      "--level 1|2|3",
      "--verifier-key",
      "--node",
      "--network <id>              CMSE_NETWORK",
      "--indexer <url>             CMSE_INDEXER_URL",
      "--max-events",
      "--raw-file",
      "--status",
      "--state-file",
      "--segment",
      "--json",
      "Exit status: 0",
      "3 not found",
    ]) {
      expect(result.out).toContain(text);
    }
  });
});

describe("command-line plumbing", () => {
  it("keeps every value of a repeatable flag in order, and refuses other flags given twice", () => {
    const spec = {
      valued: new Set(["a", "b"]),
      switches: new Set(["s"]),
      repeatable: new Set(["a", "b"]),
    };
    const parsed = parseArgs(["run", "--a", "1", "--b=2", "--a", "3", "--s"], spec);
    expect(parsed.command).toBe("run");
    expect(parsed.repeated.get("a")).toEqual(["1", "3"]);
    expect(parsed.sequence).toEqual([
      { name: "a", value: "1" },
      { name: "b", value: "2" },
      { name: "a", value: "3" },
    ]);
    expect(() =>
      parseArgs(["--x", "1", "--x", "2"], { valued: new Set(["x"]), switches: new Set() }),
    ).toThrow(UsageError);
    expect(() => parseArgs(["--s=1"], spec)).toThrow(/takes no value/);
    expect(() => parseArgs(["--a"], spec)).toThrow(/needs a value/);
  });

  it("exits only after every stream has handed its pending output over", async () => {
    const stdout = { writableLength: 70_000 };
    const drain = setInterval(() => {
      stdout.writableLength = Math.max(0, stdout.writableLength - 20_000);
    }, 5);
    const exits: { code: number; pendingAtExit: number }[] = [];
    try {
      await exitAfterFlush(0, {
        streams: [stdout, { writableLength: 0 }],
        exit: (code) => exits.push({ code, pendingAtExit: stdout.writableLength }),
        pollMs: 1,
      });
    } finally {
      clearInterval(drain);
    }
    expect(exits).toEqual([{ code: 0, pendingAtExit: 0 }]);
  });

  it("still exits, with the given status, when a stream never drains (bounded wait)", async () => {
    const exits: number[] = [];
    const started = Date.now();
    await exitAfterFlush(3, {
      streams: [{ writableLength: 1 }],
      exit: (code) => exits.push(code),
      timeoutMs: 50,
      pollMs: 5,
    });
    expect(exits).toEqual([3]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
  });
});
