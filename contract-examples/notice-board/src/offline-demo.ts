/**
 * Offline demo of the notice-board example on a local ledger (no network, no wallet):
 *
 *   deploy the board -> publish a one-part notice (one package, one intent) -> publish
 *   two notices in ONE transaction (two packages, two intents) -> read every package
 *   from the ledger's events with the reader configured for (board, its event name) and
 *   decode each merged payload as a notice -> check every package's placement from the
 *   raw transaction -> pin a notice with the board's state-changing circuit, in its own
 *   transaction.
 *
 * It also shows what the whitelist prevents: a caller without the emitter's secret
 * cannot produce a part at all.
 *
 * Run: node contract-examples/notice-board/dist/offline-demo.js (after building it).
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  ContractState as RuntimeContractState,
  createConstructorContext,
} from "@midnight-ntwrk/compact-runtime";
import {
  buildPackagesTransaction,
  buildPackageTransaction,
  type BuiltTransaction,
} from "compact-multi-segment-emit/publisher";
import {
  partEventsFromLedgerEvents,
  readPackages,
  statusFromLedgerResult,
  verifyTransactionPackages,
} from "compact-multi-segment-emit/reader";

import {
  board,
  boardAuthorityOf,
  boardOptIn,
  boardPlacement,
  buildPinTransaction,
  decodeNotice,
  noticeRequest,
  readBoard,
} from "./board.js";
import { LocalLedger } from "./local-ledger.js";

const NETWORK = "notice-board-demo";
const COIN_PUBLIC_KEY = "0".repeat(64);
const PROVABLE = ["emitPart", "pin"];

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

/** The committed verifier keys of the board (contract-examples/notice-board/keys). */
export const boardVerifierKeys = (): Record<string, Uint8Array> =>
  Object.fromEntries(
    PROVABLE.map((circuit) => [
      circuit,
      new Uint8Array(readFileSync(new URL(`../keys/${circuit}.verifier`, import.meta.url))),
    ]),
  );

/** A deterministic notice text of about `length` characters. */
export const noticeText = (length: number, seed: number): string =>
  Array.from({ length }, (_, index) => String.fromCharCode(97 + ((index * 7 + seed) % 26))).join(
    "",
  );

/** One published notice as the demo observed it. */
export interface NoticeOutcome {
  readonly notice: string;
  readonly parts: number;
  readonly segment: number;
  readonly fromEvents: string;
  readonly fromRawTransaction: string;
}

/** What the demo observed. */
export interface DemoReport {
  readonly board: string;
  readonly transactions: readonly {
    readonly intents: number;
    readonly packages: number;
    readonly notices: readonly NoticeOutcome[];
    readonly stateUnchanged: boolean;
  }[];
  readonly refusals: readonly string[];
  readonly pinnedCount: string;
  readonly pinnedDigestIsNoticeSha256: boolean;
}

/** Run the whole flow and report what happened. */
export const runOfflineDemo = async (): Promise<DemoReport> => {
  const local = new LocalLedger(NETWORK);
  const secret = Uint8Array.from(randomBytes(32));
  const initial = await board().initialState(
    createConstructorContext({ emitterSecret: secret }, COIN_PUBLIC_KEY),
    boardAuthorityOf(secret),
  );
  const address = local.deploy(initial.currentContractState, boardVerifierKeys());
  const config = { network: NETWORK, coinPublicKey: COIN_PUBLIC_KEY };
  const boardState = () =>
    RuntimeContractState.deserialize(local.state.index(address)?.serialize() ?? new Uint8Array());

  // Publish, then read back from events and check placement from the raw transaction.
  const publish = (built: BuiltTransaction, texts: readonly string[]) => {
    const before = local.state.index(address)?.serialize();
    const result = local.apply(built.transaction);
    if (result.type !== "success") throw new Error(`publication failed: ${String(result.error)}`);
    const after = local.state.index(address)?.serialize();
    const events = partEventsFromLedgerEvents(result.events, { network: NETWORK });
    const read = readPackages(events.events, { optIns: [boardOptIn(address)] });
    const transactionHash = result.events[0]?.source.transactionHash ?? "";
    const verification = verifyTransactionPackages(built.transaction.eraseProofs(), {
      ...boardPlacement(address),
      network: NETWORK,
      status: statusFromLedgerResult(result.type),
      transactionHash,
    });
    const notices = built.packages.map((expected, index) => {
      const text = texts[index] ?? "";
      const pkg = read.packages.find((entry) => entry.segment === expected.segment);
      const fromEvents =
        pkg?.status === "accepted" &&
        pkg.payload !== undefined &&
        decodeNotice(pkg.payload) === text
          ? "accepted, notice equal"
          : `unexpected: ${JSON.stringify(pkg?.issues ?? "no package")}`;
      const verified = verification.verified.find((entry) => entry.segment === expected.segment);
      const fromRawTransaction =
        verified?.payload !== undefined && decodeNotice(verified.payload) === text
          ? "guaranteed-only placement, notice equal"
          : `unexpected: ${[...verification.issues, ...verification.packages.flatMap((entry) => entry.placement)].join("; ")}`;
      return {
        notice: text.length > 24 ? `${text.slice(0, 24)}… (${String(text.length)} chars)` : text,
        parts: expected.parts.length,
        segment: expected.segment,
        fromEvents,
        fromRawTransaction,
      };
    });
    return {
      intents: built.transaction.intents?.size ?? 0,
      packages: read.packages.length,
      notices,
      stateUnchanged: before !== undefined && after !== undefined && hex(before) === hex(after),
    };
  };

  const short = "Board opens at nine.";
  const long = noticeText(600, 3);
  const third = noticeText(40, 11);
  const transactions = [
    // One notice: one package in one intent.
    publish(
      await buildPackageTransaction(local.source(), config, noticeRequest(address, secret, short)),
      [short],
    ),
    // Two notices in ONE transaction: two packages, one intent each.
    publish(
      await buildPackagesTransaction(local.source(), config, [
        noticeRequest(address, secret, long),
        noticeRequest(address, secret, third),
      ]),
      [long, third],
    ),
  ];

  // What the whitelist prevents: a part without the emitter's secret.
  const refusals: string[] = [];
  try {
    await buildPackageTransaction(
      local.source(),
      config,
      noticeRequest(address, Uint8Array.from(randomBytes(32)), "not mine"),
    );
    throw new Error("a stranger's notice was accepted");
  } catch (error) {
    refusals.push(
      `a stranger publishes: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // The board's own state changes only through pin, in its own transaction.
  const digest = Uint8Array.from(createHash("sha256").update(long).digest());
  const pin = await buildPinTransaction(
    local.source(),
    { network: NETWORK, address, coinPublicKey: COIN_PUBLIC_KEY },
    secret,
    digest,
  );
  const pinned = local.apply(pin);
  if (pinned.type !== "success") throw new Error(`pin failed: ${String(pinned.error)}`);
  const view = readBoard(boardState().data);
  return {
    board: address,
    transactions,
    refusals,
    pinnedCount: view.pinnedCount.toString(),
    pinnedDigestIsNoticeSha256: hex(view.pinnedDigest) === hex(digest),
  };
};

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(JSON.stringify(await runOfflineDemo(), null, 2));
}
