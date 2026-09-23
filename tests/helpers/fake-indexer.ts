/**
 * A fake indexer (GraphQL v4 subset) and node RPC backed by the in-process ledger, for
 * adapter and CLI tests. It answers the queries `src/adapters/indexer.ts` sends, with
 * the same field shapes as indexer 4.x: hex without 0x, block timestamps in
 * milliseconds, typed Misc `name`/`payload` padded to 32/256 bytes, `raw` ledger event
 * bytes, and `raw` transaction bytes.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type * as ledger from "@midnightntwrk/ledger-v9";

import { decodeMiscValue, statusFromLedgerResult } from "../../src/codec/raw-transaction.js";
import type { AnyTransaction } from "../../src/codec/raw-transaction.js";
import { sha256, toHex } from "./bytes.js";
import type { LocalChain } from "./ledger.js";

export interface IndexedEntry {
  readonly id: number;
  readonly hash: string;
  readonly rawHex: string;
  readonly status: string;
  readonly identifiers: readonly string[];
  readonly blockHeight: number;
  readonly blockHash: string;
  readonly blockTimestampMs: number;
  readonly events: readonly ledger.Event[];
}

export interface FakeIndexerOptions {
  /** Answer the first N requests with HTTP 503 (tests retries). */
  readonly failFirst?: number;
  /** Pretend the indexer is behind: transactions become visible only after N lookups. */
  readonly lagLookups?: number;
  /** Replace the typed name of every event (tests the raw/typed cross-check). */
  readonly corruptTypedName?: boolean;
  /** Replace the raw bytes of every event with garbage (tests the fallback). */
  readonly corruptRaw?: boolean;
}

export class FakeIndexer {
  readonly entries: IndexedEntry[] = [];
  requests = 0;
  lookups = 0;
  readonly queries: string[] = [];

  constructor(
    readonly chain: LocalChain,
    readonly options: FakeIndexerOptions = {},
  ) {}

  /**
   * Apply a transaction to the chain and index it. `applied` is what the local ledger
   * applies when `tx` itself cannot be (a stand-in finalized transaction is applied
   * with its proofs erased); `tx` is what the indexer then serves as raw bytes.
   */
  include(
    tx: AnyTransaction,
    overrides: { readonly hash?: string; readonly applied?: AnyTransaction } = {},
  ): IndexedEntry {
    const blockHeight = this.chain.height;
    const blockHash = this.chain.parentBlockHash;
    const blockTimestampMs = this.chain.seconds * 1000;
    const result = this.chain.apply(overrides.applied ?? tx);
    const fromEvents = result.events[0]?.source.transactionHash;
    let hash = overrides.hash ?? fromEvents;
    if (hash === undefined) {
      try {
        hash = tx.transactionHash();
      } catch {
        hash = toHex(sha256(tx.serialize()));
      }
    }
    const entry: IndexedEntry = {
      id: this.entries.length + 1,
      hash,
      rawHex: toHex(tx.serialize()),
      status: statusFromLedgerResult(result.type),
      identifiers: tx.identifiers(),
      blockHeight,
      blockHash,
      blockTimestampMs,
      events: result.events,
    };
    if (result.type !== "failure") this.entries.push(entry);
    return entry;
  }

  private block(height: number, hash: string, timestampMs: number) {
    return {
      hash,
      height,
      timestamp: timestampMs,
      protocolVersion: 2000000,
      ledgerParameters: toHex(this.chain.state.parameters.serialize()),
    };
  }

  private latestBlock() {
    return this.block(this.chain.height, this.chain.parentBlockHash, this.chain.seconds * 1000);
  }

  private transaction(entry: IndexedEntry) {
    return {
      __typename: "RegularTransaction",
      hash: entry.hash,
      raw: entry.rawHex,
      identifiers: entry.identifiers,
      transactionResult: { status: entry.status, segments: null },
      fee: "0",
      block: {
        hash: entry.blockHash,
        height: entry.blockHeight,
        timestamp: entry.blockTimestampMs,
      },
    };
  }

  /** With `lagLookups`, found transactions stay hidden for the first lookups. */
  private visible(): boolean {
    this.lookups += 1;
    return this.lookups > (this.options.lagLookups ?? 0);
  }

  private miscEvents(address: string, txHash?: string) {
    const out: object[] = [];
    let id = 0;
    for (const entry of this.entries) {
      for (const event of entry.events) {
        id += 1;
        const content = event.content;
        if (content.tag !== "contractLog") continue;
        const log = content as Extract<ledger.EventDetails, { tag: "contractLog" }>;
        if (log.address !== address || log.loggedItem.eventType !== "misc") continue;
        if (txHash !== undefined && entry.hash !== txHash) continue;
        const value = decodeMiscValue(log.loggedItem.data);
        const name =
          this.options.corruptTypedName === true ? "00".repeat(32) : toHex(value.slice(0, 32));
        out.push({
          __typename: "MiscContractEvent",
          id,
          name,
          payload: toHex(value.slice(32)),
          raw: this.options.corruptRaw === true ? "deadbeef" : toHex(event.serialize()),
          transaction: {
            hash: entry.hash,
            block: { height: entry.blockHeight, hash: entry.blockHash },
          },
        });
      }
    }
    return out;
  }

  /** Answer one GraphQL request. */
  answer(body: { query: string; variables?: Record<string, unknown> }): {
    status: number;
    json: unknown;
  } {
    this.requests += 1;
    this.queries.push(body.query);
    if (this.requests <= (this.options.failFirst ?? 0)) return { status: 503, json: {} };
    const query = body.query;
    const vars = body.variables ?? {};
    if (query.includes("contractEvents")) {
      const all = this.miscEvents(vars.address as string, vars.tx as string | undefined);
      const offset = Number(vars.offset ?? 0);
      const limit = Number(vars.limit ?? 100);
      return { status: 200, json: { data: { contractEvents: all.slice(offset, offset + limit) } } };
    }
    if (query.includes("transactions(offset: { hash")) {
      const found = this.entries.filter((entry) => entry.hash === vars.hash && this.visible());
      return {
        status: 200,
        json: { data: { transactions: found.map((entry) => this.transaction(entry)) } },
      };
    }
    if (query.includes("transactions(offset: { identifier")) {
      const found = this.entries.filter(
        (entry) => entry.identifiers.includes(String(vars.identifier)) && this.visible(),
      );
      return {
        status: 200,
        json: { data: { transactions: found.map((entry) => this.transaction(entry)) } },
      };
    }
    if (query.includes("contract(address")) {
      const state = this.chain.state.index(vars.address as string);
      const knownBlock = vars.hash === this.chain.parentBlockHash;
      return {
        status: 200,
        json: {
          data: {
            contract:
              state === undefined || !knownBlock ? null : { state: toHex(state.serialize()) },
            block: knownBlock ? this.latestBlock() : null,
          },
        },
      };
    }
    if (query.includes("contractAction")) {
      const state = this.chain.state.index(vars.address as string);
      const action =
        state === undefined
          ? null
          : {
              __typename: "ContractCall",
              state: toHex(state.serialize()),
              transaction: {
                hash: "00".repeat(32),
                block: { hash: this.chain.parentBlockHash, height: this.chain.height },
              },
            };
      return { status: 200, json: { data: { contractAction: action } } };
    }
    if (query.includes("block(offset: { hash")) {
      return {
        status: 200,
        json: {
          data: { block: vars.hash === this.chain.parentBlockHash ? this.latestBlock() : null },
        },
      };
    }
    if (query.includes("block {"))
      return { status: 200, json: { data: { block: this.latestBlock() } } };
    return {
      status: 200,
      json: { errors: [{ message: `fake indexer: unsupported query ${query}` }] },
    };
  }

  /** A `fetch` implementation that answers GraphQL requests in-process. */
  readonly fetch: typeof fetch = (_input, init) => {
    const body = JSON.parse((init?.body as string | undefined) ?? "{}") as {
      query: string;
      variables?: Record<string, unknown>;
    };
    const { status, json } = this.answer(body);
    return Promise.resolve(
      new Response(JSON.stringify(json), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  };

  /** Node JSON-RPC `chain_getBlock`: the block's extrinsics wrap the raw transactions. */
  nodeAnswer(body: { method: string; params: unknown[] }): unknown {
    if (body.method !== "chain_getBlock")
      return { jsonrpc: "2.0", id: 1, error: { message: "unsupported" } };
    const hash = ((body.params[0] as string | undefined) ?? "").replace(/^0x/u, "");
    const inBlock = this.entries.filter((entry) => entry.blockHash === hash);
    if (inBlock.length === 0) return { jsonrpc: "2.0", id: 1, result: null };
    return {
      jsonrpc: "2.0",
      id: 1,
      result: {
        block: { extrinsics: ["0x0400", ...inBlock.map((entry) => `0x1122${entry.rawHex}3344`)] },
      },
    };
  }

  /** Serve the indexer at `/graphql` and the node at `/rpc` on a loopback port. */
  async serve(): Promise<{
    readonly indexerUrl: string;
    readonly nodeUrl: string;
    close(): Promise<void>;
  }> {
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<
          string,
          unknown
        >;
        const isRpc = request.url === "/rpc";
        const answer = isRpc
          ? { status: 200, json: this.nodeAnswer(body as { method: string; params: unknown[] }) }
          : this.answer(body as { query: string; variables?: Record<string, unknown> });
        response.writeHead(answer.status, { "content-type": "application/json" });
        response.end(JSON.stringify(answer.json));
      });
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const { port } = server.address() as AddressInfo;
    return {
      indexerUrl: `http://127.0.0.1:${String(port)}/graphql`,
      nodeUrl: `http://127.0.0.1:${String(port)}/rpc`,
      close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
    };
  }
}
