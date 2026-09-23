/**
 * Wallet-free verification of a publication transaction, in three levels:
 *
 * - Level 1, the message: the contract's `Misc` events of the transaction (from the
 *   indexer, widths restored from the raw ledger events) form complete canonical
 *   groups with exact names and a matching SHA-256 request ID; the message is rebuilt.
 * - Level 2, the placement: from the raw finalized transaction bytes, every part is a
 *   guaranteed-only call to the contract's emission entry point in one included
 *   (SUCCESS or PARTIAL_SUCCESS) transaction; intents others merged in are ignored.
 *   The groups must equal Level 1's. With a node URL, the raw bytes must also occur in
 *   the node's copy of the block, which removes trust in the indexer for them.
 * - Level 3, the code: the verifier key the contract stores for the entry point equals
 *   the key this repository's source compiles to (the committed key, which
 *   `scripts/keys.sh verify` regenerates from source).
 *
 * Proofs are not re-verified: inclusion on chain means the network verified them.
 *
 * @module
 */
import { createHash } from "node:crypto";

import * as ledger from "@midnightntwrk/ledger-v9";

import {
  type IndexerClient,
  PublicDataError,
  publicEventsFromIndexer,
  rawTransactionInBlock,
} from "../adapters/indexer.js";
import { bytesToHex, hexToBytes } from "../codec/bytes.js";
import { verifyPublicationTransaction } from "../codec/raw-transaction.js";
import { readPublications, type ReadResult, ReadStatus } from "../codec/reader.js";

/** One level's outcome. */
export interface LevelOutcome {
  readonly ok: boolean;
  readonly lines: readonly string[];
}

/** A complete publication found in the transaction. */
export interface VerifiedPublication {
  readonly requestId: string;
  readonly parts: number;
  readonly messageBytes: number;
  readonly messageSha256: string;
  readonly messageHex: string;
}

/** The verification report. */
export interface VerifyReport {
  /** Highest level that passed (0 when Level 1 failed). */
  readonly level: number;
  readonly requestedLevel: number;
  /** The transaction or events were not found (indexer lag or wrong input). */
  readonly notFound: boolean;
  readonly transaction?: {
    readonly hash: string;
    readonly status?: string;
    readonly blockHeight?: number;
    readonly blockHash?: string;
  };
  readonly publications: readonly VerifiedPublication[];
  readonly levels: Readonly<Record<string, LevelOutcome>>;
}

/** Inputs of {@link verifyPublication}. */
export interface VerifyInput {
  readonly network: string;
  /** Contract address (the emitter). */
  readonly contract: string;
  readonly entryPoint: string;
  /** Highest level to check (1..3). */
  readonly level: number;
  /** Only this request ID must verify (others are reported). */
  readonly requestId?: string;
  /** Expected verifier key for Level 3. */
  readonly expectedVerifierKey?: Uint8Array;
  /** Online: indexer and transaction hash. */
  readonly indexer?: IndexerClient;
  readonly transactionHash?: string;
  /** Optional node RPC for the Level 2 block cross-check. */
  readonly nodeUrl?: string;
  /** Offline: saved raw transaction bytes and the inclusion status the chain reported. */
  readonly rawTransaction?: Uint8Array;
  readonly status?: string;
  /** Offline Level 3: saved serialized contract state. */
  readonly contractStateBytes?: Uint8Array;
  readonly fetch?: typeof fetch;
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const toVerified = (result: ReadResult): VerifiedPublication | undefined => {
  if (result.status !== ReadStatus.Complete || result.message === undefined) return undefined;
  return {
    requestId: result.scope.requestIdHex ?? "",
    parts: result.expectedParts ?? result.receivedParts,
    messageBytes: result.message.byteLength,
    messageSha256: sha256(result.message),
    messageHex: bytesToHex(result.message),
  };
};

const describe = (result: ReadResult): string =>
  `${result.status} request ${result.scope.requestIdHex ?? "(unscoped)"}${
    result.issues.length > 0 ? `: ${result.issues.join("; ")}` : ""
  }`;

const sameSet = (left: readonly VerifiedPublication[], right: readonly VerifiedPublication[]) => {
  const key = (p: VerifiedPublication) => `${p.requestId}:${p.messageSha256}:${String(p.parts)}`;
  const a = left.map(key).sort();
  const b = right.map(key).sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
};

/**
 * Run the verification. Never throws for a failed check; throws only for bad input or
 * an unreachable indexer/node.
 */
export const verifyPublication = async (input: VerifyInput): Promise<VerifyReport> => {
  if (input.level < 1 || input.level > 3) throw new RangeError("level must be 1, 2 or 3");
  const contract = input.contract.toLowerCase();
  const levels: Record<string, LevelOutcome> = {};
  const focus = (items: readonly VerifiedPublication[]): VerifiedPublication[] =>
    input.requestId === undefined
      ? [...items]
      : items.filter((item) => item.requestId === input.requestId?.toLowerCase());

  // Raw transaction and status: from the indexer, or from saved bytes.
  let rawTransaction = input.rawTransaction;
  let status = input.status;
  let transaction: VerifyReport["transaction"];
  if (rawTransaction === undefined) {
    if (input.indexer === undefined || input.transactionHash === undefined) {
      throw new RangeError("pass an indexer and a transaction hash, or saved raw bytes");
    }
    const [found] = await input.indexer.transactionsByHash(input.transactionHash);
    if (found === undefined) {
      return { level: 0, requestedLevel: input.level, notFound: true, publications: [], levels };
    }
    rawTransaction = hexToBytes(found.rawHex);
    status = found.status;
    transaction = {
      hash: found.hash,
      ...(found.status === undefined ? {} : { status: found.status }),
      blockHeight: found.block.height,
      blockHash: found.block.hash,
    };
  } else {
    transaction = {
      hash: input.transactionHash ?? "",
      ...(status === undefined ? {} : { status }),
    };
  }

  // Level 1: the message, from the indexer's events (or the raw transaction offline).
  let level1: VerifiedPublication[] = [];
  {
    const lines: string[] = [];
    let ok = true;
    let results: readonly ReadResult[];
    if (input.indexer !== undefined && input.transactionHash !== undefined) {
      const events = await input.indexer.miscEvents(contract, {
        transactionHash: input.transactionHash,
      });
      if (events.length === 0) {
        return {
          level: 0,
          requestedLevel: input.level,
          notFound: true,
          ...(transaction === undefined ? {} : { transaction }),
          publications: [],
          levels,
        };
      }
      const converted = publicEventsFromIndexer(events, {
        network: input.network,
        emitter: contract,
        entryPoint: input.entryPoint,
      });
      for (const issue of converted.issues) {
        const warning = issue.includes("raw bytes do not decode");
        lines.push(`${warning ? "L1 WARN" : "L1 FAIL"} ${issue}`);
        if (!warning) ok = false;
      }
      results = readPublications(converted.events).results;
      lines.push(`L1 --   ${String(events.length)} Misc events from the indexer`);
    } else {
      const report = verifyPublicationTransaction(rawTransaction, {
        emitter: contract,
        entryPoint: input.entryPoint,
        network: input.network,
        status: status ?? "",
        ...(input.transactionHash === undefined ? {} : { transactionHash: input.transactionHash }),
      });
      results = report.read.results;
      lines.push(
        `L1 --   ${String(report.emissions.length)} emissions from the saved raw transaction`,
      );
    }
    for (const result of results) {
      if (result.status === ReadStatus.Complete) {
        const verified = toVerified(result);
        if (verified !== undefined) {
          level1.push(verified);
          lines.push(
            `L1 OK   request ${verified.requestId}: ${String(verified.parts)} parts, ${String(verified.messageBytes)} bytes, message SHA-256 ${verified.messageSha256}`,
          );
        }
      } else if (
        input.requestId === undefined ||
        result.scope.requestIdHex === input.requestId.toLowerCase()
      ) {
        ok = false;
        lines.push(`L1 FAIL ${describe(result)}`);
      } else {
        lines.push(`L1 --   ignored ${describe(result)}`);
      }
    }
    level1 = focus(level1);
    if (level1.length === 0) {
      ok = false;
      lines.push("L1 FAIL no complete publication for the contract in this transaction");
    }
    levels.level1 = { ok, lines };
  }
  if (!(levels.level1?.ok ?? false)) {
    return {
      level: 0,
      requestedLevel: input.level,
      notFound: false,
      ...(transaction === undefined ? {} : { transaction }),
      publications: level1,
      levels,
    };
  }
  if (input.level < 2) {
    return {
      level: 1,
      requestedLevel: input.level,
      notFound: false,
      ...(transaction === undefined ? {} : { transaction }),
      publications: level1,
      levels,
    };
  }

  // Level 2: placement from the raw finalized transaction.
  {
    const lines: string[] = [];
    let ok = true;
    const report = verifyPublicationTransaction(rawTransaction, {
      emitter: contract,
      entryPoint: input.entryPoint,
      network: input.network,
      status: status ?? "",
      ...(transaction?.hash === undefined || transaction.hash === ""
        ? {}
        : { transactionHash: transaction.hash }),
    });
    for (const issue of report.issues) {
      ok = false;
      lines.push(`L2 FAIL ${issue}`);
    }
    const accepted = focus(
      report.accepted.flatMap((result) => {
        const verified = toVerified(result);
        return verified === undefined ? [] : [verified];
      }),
    );
    if (ok) {
      lines.push(
        `L2 OK   status ${report.status}; ${String(report.emissions.length)} guaranteed-only ${input.entryPoint} calls to ${contract} in one transaction ${report.transactionHash}`,
      );
    }
    if (!sameSet(level1, accepted)) {
      ok = false;
      lines.push("L2 FAIL the raw transaction's publications differ from the indexer's events");
    } else if (ok) {
      lines.push(`L2 OK   ${String(accepted.length)} publication(s) match Level 1`);
    }
    if (input.nodeUrl !== undefined) {
      if (transaction?.blockHash === undefined) {
        ok = false;
        lines.push("L2 FAIL the node cross-check needs the block hash (use the indexer input)");
      } else {
        const index = await rawTransactionInBlock(
          input.nodeUrl,
          transaction.blockHash,
          bytesToHex(rawTransaction),
          input.fetch === undefined ? {} : { fetch: input.fetch },
        );
        if (index === undefined) {
          ok = false;
          lines.push(
            `L2 FAIL the node's block ${transaction.blockHash} does not contain these bytes`,
          );
        } else {
          lines.push(
            `L2 OK   the node's block ${String(transaction.blockHeight)} holds the raw bytes (extrinsic ${String(index)})`,
          );
        }
      }
    }
    levels.level2 = { ok, lines };
  }
  if (!(levels.level2?.ok ?? false) || input.level < 3) {
    return {
      level: levels.level2?.ok === true ? 2 : 1,
      requestedLevel: input.level,
      notFound: false,
      ...(transaction === undefined ? {} : { transaction }),
      publications: level1,
      levels,
    };
  }

  // Level 3: the deployed verifier key.
  {
    const lines: string[] = [];
    let ok = true;
    let stateBytes = input.contractStateBytes;
    if (stateBytes === undefined && input.indexer !== undefined) {
      const { state } = await input.indexer.contractState(contract);
      if (state === undefined) throw new PublicDataError("not-found", `no contract ${contract}`);
      stateBytes = hexToBytes(state.stateHex);
    }
    if (stateBytes === undefined) throw new RangeError("Level 3 needs the contract state");
    if (input.expectedVerifierKey === undefined) {
      throw new RangeError("Level 3 needs the expected verifier key");
    }
    const deployed = ledger.ContractState.deserialize(stateBytes).operation(
      input.entryPoint,
    )?.verifierKey;
    if (deployed === undefined) {
      ok = false;
      lines.push(`L3 FAIL the contract has no ${input.entryPoint} verifier key`);
    } else if (sha256(deployed) !== sha256(input.expectedVerifierKey)) {
      ok = false;
      lines.push(
        `L3 FAIL deployed ${input.entryPoint} verifier key ${sha256(deployed)} differs from the expected ${sha256(input.expectedVerifierKey)}`,
      );
    } else {
      lines.push(
        `L3 OK   deployed ${input.entryPoint} verifier key equals the repository's (SHA-256 ${sha256(deployed)})`,
      );
    }
    levels.level3 = { ok, lines };
  }
  return {
    level: levels.level3?.ok === true ? 3 : 2,
    requestedLevel: input.level,
    notFound: false,
    ...(transaction === undefined ? {} : { transaction }),
    publications: level1,
    levels,
  };
};

/** What each level means, for the final line. */
export const LEVEL_MEANING: Readonly<Record<number, string>> = {
  0: "nothing verified",
  1: "the message is a complete canonical publication with a matching SHA-256",
  2: "and every part is a guaranteed-only emission call in one included transaction",
  3: "and the deployed emission circuit is the one this repository compiles",
};

/**
 * Exit status: 0 verified to the requested level; 1 a level failed; 3 not found
 * (usage errors, status 2, are the caller's).
 */
export const verifyExitStatus = (report: VerifyReport): number =>
  report.notFound ? 3 : report.level >= report.requestedLevel ? 0 : 1;
