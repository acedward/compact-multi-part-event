/**
 * Indexer adapter against a fake GraphQL v4 indexer backed by the in-process ledger:
 * pagination of contract events (pages of 1..N, never a prefix), the event cap,
 * retries on HTTP 503 and network errors, GraphQL errors, the state source (one block,
 * state at that block, network ledger parameters, seconds), waiting through indexer
 * lag, width restoration from raw ledger events with a typed-field cross-check, and the
 * node RPC block cross-check.
 */
import * as ledger from "@midnightntwrk/ledger-v9";
import { beforeAll, describe, expect, it } from "vitest";

import {
  IndexerClient,
  indexerStateSource,
  PublicDataError,
  publicEventsFromIndexer,
  rawTransactionInBlock,
  waitForTransaction,
} from "../src/adapters/indexer.js";
import { encodePublication, ReadStatus, readPublications } from "../src/codec/index.js";
import { buildPublicationTransaction } from "../src/transaction/index.js";
import { filled32, patternMessage } from "./helpers/bytes.js";
import { FakeIndexer, type IndexedEntry } from "./helpers/fake-indexer.js";
import { configFor, deployEmitter, emitterBinding, LocalChain, NETWORK } from "./helpers/ledger.js";

const SECRET = filled32(0x61);
let chain: LocalChain;
let emitter: string;
let fake: FakeIndexer;
let first: IndexedEntry;
let second: IndexedEntry;
const MESSAGE = patternMessage(1000, 3);

const client = (
  indexer: FakeIndexer,
  extra: Partial<ConstructorParameters<typeof IndexerClient>[0]> = {},
) =>
  new IndexerClient({
    url: "http://fake.invalid/api/v4/graphql",
    fetch: indexer.fetch,
    sleep: () => Promise.resolve(),
    ...extra,
  });

beforeAll(async () => {
  chain = new LocalChain();
  emitter = await deployEmitter(chain, SECRET);
  fake = new FakeIndexer(chain);
  for (const message of [MESSAGE, patternMessage(0)]) {
    const built = await buildPublicationTransaction(
      chain.source(),
      emitterBinding(SECRET),
      configFor(emitter),
      encodePublication(message),
    );
    const entry = fake.include(built.transaction.eraseProofs());
    if (first === undefined) first = entry;
    else second = entry;
  }
});

describe("contract events", () => {
  it.each([1, 2, 3, 5, 500])(
    "page size %i returns every event of the transaction, in order",
    async (pageSize) => {
      const events = await client(fake).miscEvents(emitter, {
        transactionHash: first.hash,
        pageSize,
      });
      expect(events).toHaveLength(5);
      expect(events.map((event) => event.id)).toEqual(
        [...events.map((e) => e.id)].sort((a, b) => a - b),
      );
      expect(new Set(events.map((event) => event.transactionHash))).toEqual(new Set([first.hash]));
    },
  );

  it("filters by transaction and lists all transactions without a filter", async () => {
    expect(await client(fake).miscEvents(emitter, { transactionHash: second.hash })).toHaveLength(
      1,
    );
    expect(await client(fake).miscEvents(emitter)).toHaveLength(6);
  });

  it("refuses more events than the cap, and page sizes outside 1..500", async () => {
    await expect(client(fake).miscEvents(emitter, { maxEvents: 3, pageSize: 2 })).rejects.toThrow(
      /more than 3 events/,
    );
    await expect(client(fake).miscEvents(emitter, { pageSize: 501 })).rejects.toThrow(RangeError);
  });

  it("restores widths from the raw ledger events and reconstructs the message; the empty message too", async () => {
    for (const [entry, message] of [
      [first, MESSAGE],
      [second, new Uint8Array()],
    ] as const) {
      const events = await client(fake).miscEvents(emitter, { transactionHash: entry.hash });
      const converted = publicEventsFromIndexer(events, {
        network: NETWORK,
        emitter,
        entryPoint: "emitPart",
      });
      expect(converted.issues).toEqual([]);
      expect(converted.events.every((event) => event.name.byteLength === 32)).toBe(true);
      expect(converted.events.every((event) => event.payload.byteLength === 256)).toBe(true);
      const { results } = readPublications(converted.events);
      expect(results).toHaveLength(1);
      expect(results[0]?.status).toBe(ReadStatus.Complete);
      expect(results[0]?.message).toEqual(message);
    }
  });

  it("an entry point other than the expected one yields nothing", async () => {
    const events = await client(fake).miscEvents(emitter, { transactionHash: first.hash });
    const converted = publicEventsFromIndexer(events, {
      network: NETWORK,
      emitter,
      entryPoint: "somethingElse",
    });
    expect(converted.events).toEqual([]);
  });

  it("reports typed fields that disagree with the raw event, and falls back when raw bytes do not decode", async () => {
    const corruptName = new FakeIndexer(chain, { corruptTypedName: true });
    corruptName.entries.push(first);
    const named = publicEventsFromIndexer(
      await client(corruptName).miscEvents(emitter, { transactionHash: first.hash }),
      { network: NETWORK, emitter, entryPoint: "emitPart" },
    );
    expect(named.issues).toHaveLength(5);
    expect(named.issues[0]).toMatch(/typed name\/payload disagree with the raw event/);

    const corruptRaw = new FakeIndexer(chain, { corruptRaw: true });
    corruptRaw.entries.push(first);
    const fallback = publicEventsFromIndexer(
      await client(corruptRaw).miscEvents(emitter, { transactionHash: first.hash }),
      { network: NETWORK, emitter, entryPoint: "emitPart" },
    );
    expect(fallback.issues[0]).toMatch(/raw bytes do not decode; entry point unchecked/);
    expect(readPublications(fallback.events).results[0]?.message).toEqual(MESSAGE);
  });
});

describe("requests", () => {
  it("retries HTTP 503 and network errors, then answers", async () => {
    const flaky = new FakeIndexer(chain, { failFirst: 2 });
    const block = await client(flaky).latestBlock();
    expect(block.height).toBe(chain.height);
    expect(flaky.requests).toBe(3);

    let calls = 0;
    const failing: typeof fetch = (input, init) => {
      calls += 1;
      return calls < 3 ? Promise.reject(new Error("ECONNRESET")) : fake.fetch(input, init);
    };
    await expect(client(fake, { fetch: failing }).latestBlock()).resolves.toMatchObject({
      height: chain.height,
    });
  });

  it("gives up after the attempts and reports GraphQL errors without retrying", async () => {
    const down = new FakeIndexer(chain, { failFirst: 100 });
    await expect(client(down, { maxAttempts: 2 }).latestBlock()).rejects.toThrow(/HTTP 503/);
    expect(down.requests).toBe(2);
    const broken = client(fake);
    await expect(broken.query("query { nonsense }")).rejects.toThrow(PublicDataError);
  });

  it("finds transactions by hash and by identifier, with status and raw bytes", async () => {
    const [byHash] = await client(fake).transactionsByHash(first.hash);
    expect(byHash?.status).toBe("SUCCESS");
    expect(byHash?.rawHex).toBe(first.rawHex);
    const identifier = first.identifiers[0] ?? "";
    const [byIdentifier] = await client(fake).transactionsByIdentifier(identifier);
    expect(byIdentifier?.hash).toBe(first.hash);
    expect(await client(fake).transactionsByHash("ab".repeat(32))).toEqual([]);
  });

  it("waits through indexer lag, and returns undefined after the timeout", async () => {
    const lagging = new FakeIndexer(chain, { lagLookups: 3 });
    lagging.entries.push(first);
    let now = 0;
    const found = await waitForTransaction(
      client(lagging),
      { identifiers: first.identifiers.slice(0, 1) },
      { pollMs: 10, timeoutMs: 1000, sleep: () => Promise.resolve(), now: () => now },
    );
    expect(found?.hash).toBe(first.hash);
    expect(lagging.lookups).toBe(4);

    const missing = await waitForTransaction(
      client(fake),
      { identifiers: ["00".repeat(33)] },
      {
        pollMs: 10,
        timeoutMs: 50,
        sleep: () => {
          now += 10;
          return Promise.resolve();
        },
        now: () => now,
      },
    );
    expect(missing).toBeUndefined();
  });
});

describe("state source", () => {
  it("pins one block, reads the state at that block, converts milliseconds to seconds, and uses the network's parameters", async () => {
    const source = indexerStateSource(client(fake));
    const block = await source.latestBlock();
    expect(block).toEqual({
      hash: chain.parentBlockHash,
      height: chain.height,
      timestampSeconds: chain.seconds,
    });
    const snapshot = await source.contractStateAt(emitter, block.hash);
    expect(snapshot.contractState.serialize()).toEqual(chain.state.index(emitter)?.serialize());
    expect(snapshot.ledgerParameters.serialize()).toEqual(chain.state.parameters.serialize());
    await expect(source.contractStateAt(emitter, "cd".repeat(32))).rejects.toThrow(/no contract/);
    await expect(source.contractStateAt("ef".repeat(32), block.hash)).rejects.toThrow(
      /no contract/,
    );
  });

  it("builds a publication through the indexer source that equals one built from the chain directly", async () => {
    const publication = encodePublication(patternMessage(300));
    const built = await buildPublicationTransaction(
      indexerStateSource(client(fake)),
      emitterBinding(SECRET),
      configFor(emitter),
      publication,
    );
    expect(built.block.hash).toBe(chain.parentBlockHash);
    expect(built.expected.tails).toHaveLength(2);
    const fork = chain.fork();
    const result = fork.apply(built.transaction.eraseProofs());
    expect(result.type).toBe("success");
  });
});

describe("node cross-check", () => {
  it("finds the raw transaction inside the node's block, and not in another block", async () => {
    const node: typeof fetch = (_input, init) =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            fake.nodeAnswer(
              JSON.parse(init?.body as string) as { method: string; params: unknown[] },
            ),
          ),
        ),
      );
    expect(
      await rawTransactionInBlock("http://node.invalid", first.blockHash, first.rawHex, {
        fetch: node,
      }),
    ).toBe(1);
    expect(
      await rawTransactionInBlock("http://node.invalid", second.blockHash, first.rawHex, {
        fetch: node,
      }),
    ).toBeUndefined();
    await expect(
      rawTransactionInBlock("http://node.invalid", "12".repeat(32), first.rawHex, { fetch: node }),
    ).rejects.toThrow(/does not know the block/);
  });
});

/**
 * Opt-in, READ-ONLY check against a live indexer (no wallet, no transaction):
 *   CMSE_LIVE_INDEXER_URL=https://indexer.stagenet.shielded.tools/api/v4/graphql
 * It decodes the live ledger parameters, a known stagenet transaction and its events
 * with the pinned ledger-v9, and pages through the events.
 */
const LIVE = process.env.CMSE_LIVE_INDEXER_URL ?? "";
const KNOWN_CONTRACT = "294c2b6a9e405842294f9f273271047aa235654aaeb8dc4d6f44f5cd707cf913";
const KNOWN_TX = "7bdbf4b525c497c7e082557e6b3616def8439384a51ef6e9b34c478a36dbc63e";

describe.skipIf(LIVE === "")("live indexer (read-only)", () => {
  it("decodes the latest block's ledger parameters with the pinned ledger", async () => {
    const live = new IndexerClient({ url: LIVE });
    const block = await live.latestBlock();
    expect(block.height).toBeGreaterThan(0);
    expect(block.timestampMs).toBeGreaterThan(1_700_000_000_000);
    const parameters = ledger.LedgerParameters.deserialize(
      Buffer.from(block.ledgerParametersHex ?? "", "hex"),
    );
    expect(parameters.serialize().byteLength).toBeGreaterThan(0);
    console.log(`[live] block ${String(block.height)} ${block.hash}`);
  });

  it("decodes a known transaction, its events (paged by 1) and the contract state", async () => {
    const live = new IndexerClient({ url: LIVE });
    const [tx] = await live.transactionsByHash(KNOWN_TX);
    expect(tx?.status).toBe("SUCCESS");
    const decoded = ledger.Transaction.deserialize(
      "signature",
      "proof",
      "binding",
      Buffer.from(tx?.rawHex ?? "", "hex"),
    );
    expect(decoded.transactionHash()).toBe(KNOWN_TX);
    const events = await live.miscEvents(KNOWN_CONTRACT, {
      transactionHash: KNOWN_TX,
      pageSize: 1,
    });
    expect(events.length).toBeGreaterThan(0);
    const raw = ledger.Event.deserialize(Buffer.from(events[0]?.rawHex ?? "", "hex"));
    expect(raw.source.transactionHash).toBe(KNOWN_TX);
    const source = indexerStateSource(live);
    const block = await source.latestBlock();
    const snapshot = await source.contractStateAt(KNOWN_CONTRACT, block.hash);
    expect(
      ledger.ContractState.deserialize(snapshot.contractState.serialize()).operations().length,
    ).toBeGreaterThan(0);
    console.log(`[live] ${String(events.length)} events; state at block ${String(block.height)}`);
  });
});
