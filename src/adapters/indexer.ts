/**
 * Public-data adapter for the Midnight indexer's GraphQL v4 API (tested against
 * indexer 4.x at `https://indexer.stagenet.shielded.tools/api/v4/graphql`), plus an
 * optional node RPC cross-check.
 *
 * What it reads, all without a wallet:
 * - blocks (hash, height, timestamp in MILLISECONDS, serialized ledger parameters);
 * - a contract's serialized state at a block, with that block's ledger parameters, as
 *   the composer's {@link PublicationStateSource} (one latest block, then the state at
 *   exactly that block hash);
 * - a transaction by hash or by any of its identifiers: raw bytes, identifiers, status
 *   (`SUCCESS`, `PARTIAL_SUCCESS`, `FAILURE`) and block;
 * - a contract's `Misc` events, paginated (`limit` at most 500, `offset`), filtered by
 *   transaction hash. The top-level `contractEvents` query is used on purpose: the
 *   per-call event list is empty when a transaction holds several calls to one
 *   contract entry point, which is exactly a publication.
 *
 * Indexer data is trusted as served. `verify` reduces that trust by checking the raw
 * transaction bytes against the node's block ({@link rawTransactionInBlock}).
 *
 * @module
 */
import * as ledger from "@midnightntwrk/ledger-v9";

import { bytesEqual, bytesToHex, hexToBytes } from "../codec/bytes.js";
import { publicEventsFromLedgerEvents } from "../codec/raw-transaction.js";
import type { PublicEvent } from "../codec/reader.js";
import { restoreIndexerMiscEvent } from "../codec/widths.js";
import type {
  ContractSnapshot,
  PinnedBlock,
  PublicationStateSource,
} from "../transaction/compose.js";

/** A failed indexer or node request. */
export class PublicDataError extends Error {
  constructor(
    readonly kind: "http" | "graphql" | "network" | "shape" | "not-found" | "timeout",
    detail: string,
  ) {
    super(detail);
    this.name = "PublicDataError";
  }
}

/** Largest page the indexer serves for `contractEvents`. */
export const MAX_EVENT_PAGE = 500;

/** Options for {@link IndexerClient}. */
export interface IndexerClientOptions {
  /** GraphQL HTTP endpoint, e.g. `https://…/api/v4/graphql`. */
  readonly url: string;
  /** Injectable fetch (tests); defaults to the global fetch. */
  readonly fetch?: typeof fetch;
  /** Per-request timeout in milliseconds (default 30000). */
  readonly timeoutMs?: number;
  /** Attempts per request for network errors, HTTP 429 and 5xx (default 4). */
  readonly maxAttempts?: number;
  /** Injectable sleep (tests). */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** A block as the indexer reports it. */
export interface IndexedBlock {
  readonly hash: string;
  readonly height: number;
  /** Milliseconds since the Unix epoch (the indexer's unit). */
  readonly timestampMs: number;
  readonly protocolVersion?: number;
  /** Serialized `LedgerParameters`, hex (present when requested). */
  readonly ledgerParametersHex?: string;
}

/** A transaction as the indexer reports it. */
export interface IndexedTransaction {
  readonly typename: string;
  readonly hash: string;
  readonly rawHex: string;
  readonly identifiers: readonly string[];
  /** `SUCCESS`, `PARTIAL_SUCCESS` or `FAILURE`; absent for system transactions. */
  readonly status?: string;
  readonly segments?: readonly { readonly id: number; readonly success: boolean }[];
  readonly fee?: string;
  readonly block: IndexedBlock;
}

/** A `Misc` contract event as the indexer reports it (hex fields as served). */
export interface IndexedMiscEvent {
  readonly id: number;
  readonly nameHex: string;
  readonly payloadHex: string;
  readonly rawHex: string;
  readonly transactionHash: string;
  readonly blockHeight: number;
  readonly blockHash: string;
}

/** Serialized contract state (with the action that produced it, for the latest state). */
export interface IndexedContractState {
  readonly stateHex: string;
  readonly actionType?: string;
  readonly transactionHash?: string;
  readonly blockHeight?: number;
}

const BLOCK_FIELDS = "hash height timestamp protocolVersion ledgerParameters";
const TRANSACTION_FIELDS = `__typename hash raw block { hash height timestamp }
  ... on RegularTransaction { identifiers transactionResult { status segments { id success } } fee }`;

interface RawBlock {
  hash: string;
  height: number;
  timestamp: number;
  protocolVersion?: number;
  ledgerParameters?: string;
}

const toBlock = (block: RawBlock | null | undefined, what: string): IndexedBlock => {
  if (
    block === null ||
    block === undefined ||
    typeof block.hash !== "string" ||
    !Number.isSafeInteger(block.height) ||
    !Number.isSafeInteger(block.timestamp)
  ) {
    throw new PublicDataError("shape", `${what}: block has no hash, height or timestamp`);
  }
  return {
    hash: block.hash,
    height: block.height,
    timestampMs: block.timestamp,
    ...(block.protocolVersion === undefined ? {} : { protocolVersion: block.protocolVersion }),
    ...(block.ledgerParameters === undefined
      ? {}
      : { ledgerParametersHex: block.ledgerParameters }),
  };
};

interface RawTransaction {
  __typename: string;
  hash: string;
  raw: string;
  identifiers?: string[];
  transactionResult?: { status: string; segments: { id: number; success: boolean }[] | null };
  fee?: string;
  block: RawBlock;
}

const toTransaction = (tx: RawTransaction): IndexedTransaction => ({
  typename: tx.__typename,
  hash: tx.hash,
  rawHex: tx.raw,
  identifiers: tx.identifiers ?? [],
  ...(tx.transactionResult === undefined ? {} : { status: tx.transactionResult.status }),
  ...(tx.transactionResult?.segments === null || tx.transactionResult?.segments === undefined
    ? {}
    : { segments: tx.transactionResult.segments }),
  ...(tx.fee === undefined ? {} : { fee: tx.fee }),
  block: toBlock(tx.block, `transaction ${tx.hash}`),
});

const isHex = (value: string): boolean => /^[0-9a-f]*$/.test(value) && value.length % 2 === 0;

const normalizeHex = (value: string, name: string): string => {
  const hex = value.replace(/^0x/i, "").toLowerCase();
  if (!isHex(hex) || hex.length === 0) throw new RangeError(`${name} must be hex`);
  return hex;
};

/** A small GraphQL client for the indexer's v4 API. */
export class IndexerClient {
  readonly url: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #maxAttempts: number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: IndexerClientOptions) {
    const parsed = new URL(options.url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new RangeError("indexer URL must be http(s)");
    }
    this.url = options.url;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#maxAttempts = options.maxAttempts ?? 4;
    this.#sleep =
      options.sleep ?? ((ms) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms)));
  }

  /** Run one GraphQL query, retrying network errors, HTTP 429 and 5xx. */
  async query<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    let lastError: PublicDataError | undefined;
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      if (attempt > 1) await this.#sleep(Math.min(10_000, 500 * 2 ** (attempt - 2)));
      let response: Response;
      try {
        response = await this.#fetch(this.url, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ query, variables }),
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
      } catch (error) {
        lastError = new PublicDataError(
          "network",
          `indexer request failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      if (response.status === 429 || response.status >= 500) {
        lastError = new PublicDataError("http", `indexer answered HTTP ${String(response.status)}`);
        continue;
      }
      if (!response.ok) {
        throw new PublicDataError("http", `indexer answered HTTP ${String(response.status)}`);
      }
      const body = (await response.json()) as {
        data?: T;
        errors?: { message: string }[];
      };
      if (body.errors !== undefined && body.errors.length > 0) {
        throw new PublicDataError(
          "graphql",
          `indexer error: ${body.errors.map((error) => error.message).join("; ")}`,
        );
      }
      if (body.data === undefined) throw new PublicDataError("shape", "indexer returned no data");
      return body.data;
    }
    throw lastError ?? new PublicDataError("network", "indexer request failed");
  }

  /** The latest block known to the indexer. */
  async latestBlock(): Promise<IndexedBlock> {
    const data = await this.query<{ block: RawBlock | null }>(
      `query { block { ${BLOCK_FIELDS} } }`,
    );
    return toBlock(data.block, "latest block");
  }

  /** A block by hash, or `undefined` if the indexer does not know it. */
  async blockByHash(hash: string): Promise<IndexedBlock | undefined> {
    const data = await this.query<{ block: RawBlock | null }>(
      `query ($hash: HexEncoded!) { block(offset: { hash: $hash }) { ${BLOCK_FIELDS} } }`,
      { hash: normalizeHex(hash, "block hash") },
    );
    return data.block === null ? undefined : toBlock(data.block, `block ${hash}`);
  }

  /** A block by height, or `undefined` if the indexer does not have it yet. */
  async blockByHeight(height: number): Promise<IndexedBlock | undefined> {
    const data = await this.query<{ block: RawBlock | null }>(
      `query ($height: Int!) { block(offset: { height: $height }) { ${BLOCK_FIELDS} } }`,
      { height },
    );
    return data.block === null ? undefined : toBlock(data.block, `block ${String(height)}`);
  }

  /**
   * A contract's serialized state: the latest, or as of a block (its last action at or
   * before that block) together with that block's ledger parameters.
   *
   * The as-of form uses `contract(address, offset)`, which the indexer documents for
   * building transactions; `contractAction(address, offset: { blockOffset })` would
   * only return an action inside that exact block.
   */
  async contractState(
    address: string,
    blockHash?: string,
  ): Promise<{ state?: IndexedContractState; block?: IndexedBlock }> {
    const addressHex = normalizeHex(address, "contract address");
    if (blockHash === undefined) {
      const data = await this.query<{ contractAction: RawAction | null }>(
        `query ($address: HexEncoded!) {
          contractAction(address: $address) { __typename state transaction { hash block { hash height } } }
        }`,
        { address: addressHex },
      );
      return data.contractAction === null ? {} : { state: toState(data.contractAction) };
    }
    const data = await this.query<{ contract: { state: string } | null; block: RawBlock | null }>(
      `query ($address: HexEncoded!, $hash: HexEncoded!) {
        contract(address: $address, offset: { hash: $hash }) { state }
        block(offset: { hash: $hash }) { ${BLOCK_FIELDS} }
      }`,
      { address: addressHex, hash: normalizeHex(blockHash, "block hash") },
    );
    return {
      ...(data.contract === null ? {} : { state: { stateHex: data.contract.state } }),
      ...(data.block === null ? {} : { block: toBlock(data.block, `block ${blockHash}`) }),
    };
  }

  /** Transactions with this hash (normally one). */
  async transactionsByHash(hash: string): Promise<IndexedTransaction[]> {
    const data = await this.query<{ transactions: RawTransaction[] }>(
      `query ($hash: HexEncoded!) { transactions(offset: { hash: $hash }) { ${TRANSACTION_FIELDS} } }`,
      { hash: normalizeHex(hash, "transaction hash") },
    );
    return data.transactions.map(toTransaction);
  }

  /** The transaction that carries this identifier, if included. */
  async transactionsByIdentifier(identifier: string): Promise<IndexedTransaction[]> {
    const data = await this.query<{ transactions: RawTransaction[] }>(
      `query ($identifier: HexEncoded!) { transactions(offset: { identifier: $identifier }) { ${TRANSACTION_FIELDS} } }`,
      { identifier: normalizeHex(identifier, "transaction identifier") },
    );
    return data.transactions.map(toTransaction);
  }

  /**
   * Every `Misc` event of a contract (optionally of one transaction), following pages
   * until a short page. Refuses to collect more than `maxEvents`.
   */
  async miscEvents(
    address: string,
    options: {
      readonly transactionHash?: string;
      readonly pageSize?: number;
      readonly maxEvents?: number;
    } = {},
  ): Promise<IndexedMiscEvent[]> {
    const pageSize = options.pageSize ?? MAX_EVENT_PAGE;
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_EVENT_PAGE) {
      throw new RangeError(`pageSize must be 1..${String(MAX_EVENT_PAGE)}`);
    }
    const maxEvents = options.maxEvents ?? 4096;
    const variables: Record<string, unknown> = {
      address: normalizeHex(address, "contract address"),
      limit: pageSize,
    };
    const filter =
      options.transactionHash === undefined
        ? "{ contractAddress: $address, types: [MISC] }"
        : "{ contractAddress: $address, transactionHash: $tx, types: [MISC] }";
    if (options.transactionHash !== undefined) {
      variables.tx = normalizeHex(options.transactionHash, "transaction hash");
    }
    const declarations =
      options.transactionHash === undefined
        ? "$address: HexEncoded!, $limit: Int!, $offset: Int!"
        : "$address: HexEncoded!, $tx: HexEncoded!, $limit: Int!, $offset: Int!";
    const out: IndexedMiscEvent[] = [];
    for (let offset = 0; ; offset += pageSize) {
      const data = await this.query<{ contractEvents: RawEvent[] }>(
        `query (${declarations}) {
          contractEvents(filter: ${filter}, limit: $limit, offset: $offset) {
            __typename id
            ... on MiscContractEvent { name payload raw transaction { hash block { height hash } } }
          }
        }`,
        { ...variables, offset },
      );
      for (const event of data.contractEvents) {
        if (event.__typename !== "MiscContractEvent") continue;
        out.push({
          id: event.id,
          nameHex: event.name ?? "",
          payloadHex: event.payload ?? "",
          rawHex: event.raw ?? "",
          transactionHash: event.transaction?.hash ?? "",
          blockHeight: event.transaction?.block?.height ?? -1,
          blockHash: event.transaction?.block?.hash ?? "",
        });
      }
      if (out.length > maxEvents) {
        throw new PublicDataError("shape", `more than ${String(maxEvents)} events; refusing`);
      }
      if (data.contractEvents.length < pageSize) break;
    }
    return out;
  }
}

interface RawAction {
  __typename: string;
  state: string;
  transaction: { hash: string; block: { hash: string; height: number } };
}

const toState = (action: RawAction): IndexedContractState => ({
  stateHex: action.state,
  actionType: action.__typename,
  transactionHash: action.transaction.hash,
  blockHeight: action.transaction.block.height,
});

interface RawEvent {
  __typename: string;
  id: number;
  name?: string;
  payload?: string;
  raw?: string;
  transaction?: { hash: string; block?: { height: number; hash: string } };
}

/** Deserialize an indexer `ledgerParameters` field. */
export const ledgerParametersFromHex = (hex: string): ledger.LedgerParameters =>
  ledger.LedgerParameters.deserialize(hexToBytes(hex));

/**
 * The composer's state source over the indexer: the latest block (time converted to
 * seconds), then the contract state and ledger parameters at exactly that block.
 * The parameters are the network's, never `LedgerParameters.initialParameters()`.
 */
export const indexerStateSource = (client: IndexerClient): PublicationStateSource => ({
  latestBlock: async (): Promise<PinnedBlock> => {
    const block = await client.latestBlock();
    return {
      hash: block.hash,
      height: block.height,
      timestampSeconds: Math.floor(block.timestampMs / 1000),
    };
  },
  contractStateAt: async (address: string, blockHash: string): Promise<ContractSnapshot> => {
    const { state, block } = await client.contractState(address, blockHash);
    if (state === undefined) {
      throw new PublicDataError("not-found", `no contract ${address} at block ${blockHash}`);
    }
    if (block?.ledgerParametersHex === undefined) {
      throw new PublicDataError("not-found", `no ledger parameters for block ${blockHash}`);
    }
    const bytes = hexToBytes(state.stateHex);
    return {
      contractState: { serialize: () => bytes },
      ledgerParameters: ledgerParametersFromHex(block.ledgerParametersHex),
    };
  },
});

/** Reader input built from indexer events, with the problems found. */
export interface IndexerEventConversion {
  readonly events: PublicEvent[];
  /** Events that could not be used or whose typed fields disagree with `raw`. */
  readonly issues: string[];
}

/**
 * Turn indexer `Misc` events into strict-reader input. The `raw` ledger event is the
 * source (it carries the entry point and the trimmed value; widths are restored); the
 * typed `name`/`payload` fields must agree with it after width restoration. An event
 * whose `raw` bytes cannot be decoded falls back to the typed fields and is reported.
 */
export const publicEventsFromIndexer = (
  indexed: readonly IndexedMiscEvent[],
  options: { readonly network: string; readonly emitter: string; readonly entryPoint: string },
): IndexerEventConversion => {
  const events: PublicEvent[] = [];
  const issues: string[] = [];
  for (const item of indexed) {
    const eventId = `indexer:${String(item.id)}`;
    let ledgerEvent: ledger.Event | undefined;
    try {
      ledgerEvent = ledger.Event.deserialize(hexToBytes(item.rawHex));
    } catch {
      ledgerEvent = undefined;
    }
    if (ledgerEvent === undefined) {
      issues.push(`event ${eventId}: raw bytes do not decode; entry point unchecked`);
      try {
        const restored = restoreIndexerMiscEvent({ name: item.nameHex, payload: item.payloadHex });
        events.push({
          network: options.network,
          emitter: options.emitter,
          transactionId: item.transactionHash,
          eventId,
          name: restored.name,
          payload: restored.payload,
        });
      } catch (error) {
        issues.push(`event ${eventId}: ${error instanceof Error ? error.message : String(error)}`);
      }
      continue;
    }
    const converted = publicEventsFromLedgerEvents([ledgerEvent], {
      ...options,
      eventIdOf: () => eventId,
    });
    issues.push(...converted.issues);
    for (const event of converted.events) {
      try {
        const typed = restoreIndexerMiscEvent({ name: item.nameHex, payload: item.payloadHex });
        if (!bytesEqual(typed.name, event.name) || !bytesEqual(typed.payload, event.payload)) {
          issues.push(`event ${eventId}: typed name/payload disagree with the raw event`);
        }
      } catch (error) {
        issues.push(
          `event ${eventId}: typed fields: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      events.push({ ...event, network: options.network, transactionId: item.transactionHash });
    }
  }
  return { events, issues };
};

/** Options for {@link waitForTransaction}. */
export interface WaitOptions {
  /** Give up after this many milliseconds (default 600000). */
  readonly timeoutMs?: number;
  /** Poll interval (default 3000). */
  readonly pollMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

/**
 * Poll the indexer until a transaction carrying any of `identifiers` (or with `hash`)
 * appears, tolerating indexer lag. Returns `undefined` on timeout: the caller must
 * inspect public state before doing anything else, never resubmit blindly.
 */
export const waitForTransaction = async (
  client: IndexerClient,
  target: { readonly identifiers?: readonly string[]; readonly hash?: string },
  options: WaitOptions = {},
): Promise<IndexedTransaction | undefined> => {
  const timeoutMs = options.timeoutMs ?? 600_000;
  const pollMs = options.pollMs ?? 3000;
  const sleep =
    options.sleep ?? ((ms) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms)));
  const now = options.now ?? Date.now;
  const deadline = now() + timeoutMs;
  for (;;) {
    for (const identifier of target.identifiers ?? []) {
      const [found] = await client.transactionsByIdentifier(identifier);
      if (found !== undefined) return found;
    }
    if (target.hash !== undefined) {
      const [found] = await client.transactionsByHash(target.hash);
      if (found !== undefined) return found;
    }
    if (now() >= deadline) return undefined;
    await sleep(pollMs);
  }
};

/** Options for {@link rawTransactionInBlock}. */
export interface NodeRpcOptions {
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

/**
 * Ask a node (JSON-RPC `chain_getBlock`) whether the raw transaction bytes occur
 * verbatim inside one of the block's extrinsics. This removes trust in the indexer
 * for "these bytes are in that block".
 *
 * @returns The extrinsic index, or `undefined` if no extrinsic contains the bytes.
 * @throws {PublicDataError} If the node does not answer or does not know the block.
 */
export const rawTransactionInBlock = async (
  rpcUrl: string,
  blockHash: string,
  rawHex: string,
  options: NodeRpcOptions = {},
): Promise<number | undefined> => {
  const doFetch = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "chain_getBlock",
        params: [`0x${normalizeHex(blockHash, "block hash")}`],
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
  } catch (error) {
    throw new PublicDataError(
      "network",
      `node request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok)
    throw new PublicDataError("http", `node answered HTTP ${String(response.status)}`);
  const body = (await response.json()) as {
    result?: { block?: { extrinsics?: string[] } } | null;
    error?: { message: string };
  };
  if (body.error !== undefined) throw new PublicDataError("graphql", body.error.message);
  const extrinsics = body.result?.block?.extrinsics;
  if (extrinsics === undefined)
    throw new PublicDataError("not-found", "node does not know the block");
  const needle = normalizeHex(rawHex, "raw transaction");
  const index = extrinsics.findIndex((extrinsic) => extrinsic.toLowerCase().includes(needle));
  return index < 0 ? undefined : index;
};

/** Hex helper re-exported for callers that record evidence. */
export const hexOf = bytesToHex;
