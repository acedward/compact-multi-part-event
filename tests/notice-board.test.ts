/**
 * The notice-board example (US3): a second adopter with state of its own and its own
 * event name, its committed verifier keys, its client over the library's public entry
 * points, packages read and verified with its (contract, name) configuration, and the
 * offline demo.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  ContractState as RuntimeContractState,
  createConstructorContext,
} from "@midnight-ntwrk/compact-runtime";
import { beforeAll, describe, expect, it } from "vitest";

import {
  board,
  boardAuthorityOf,
  boardOptIn,
  boardPlacement,
  type BoardPrivateState,
  buildPinTransaction,
  decodeNotice,
  encodeNotice,
  noticeRequest,
  readBoard,
} from "../contract-examples/notice-board/src/board.js";
import { runOfflineDemo } from "../contract-examples/notice-board/src/offline-demo.js";
import { buildPackagesTransaction, buildPackageTransaction } from "../src/publisher/index.js";
import {
  partEventsFromLedgerEvents,
  readPackages,
  statusFromLedgerResult,
  verifyTransactionPackages,
} from "../src/reader/index.js";
import { filled32 } from "./helpers/bytes.js";
import {
  BOARD_VERIFIER_KEYS,
  COIN_PUBLIC_KEY,
  EXAMPLE_NAME,
  repoFile,
} from "./helpers/generated.js";
import {
  configFor,
  deploy,
  deployEmitter,
  emitterBinding,
  LocalChain,
  NETWORK,
  requestFor,
} from "./helpers/ledger.js";

const sha = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");
const SECRET = filled32(0x41);

let chain: LocalChain;
let address: string;

const deployBoard = async (secret: Uint8Array): Promise<string> => {
  const initial = await board().initialState(
    createConstructorContext<BoardPrivateState>({ emitterSecret: secret }, COIN_PUBLIC_KEY),
    boardAuthorityOf(secret),
  );
  const state = initial.currentContractState;
  for (const [circuit, key] of Object.entries(BOARD_VERIFIER_KEYS)) {
    const operation = state.operation(circuit);
    if (operation === undefined) throw new Error(`no ${circuit}`);
    operation.verifierKey = key;
    state.setOperation(circuit, operation);
  }
  return deploy(chain, state);
};

beforeAll(async () => {
  chain = new LocalChain();
  address = await deployBoard(SECRET);
});

describe("committed keys", () => {
  it("commits a verifier key per provable circuit, each listed in SHA256SUMS with its hash", () => {
    const listing = readFileSync(repoFile("contract-examples/notice-board/keys/SHA256SUMS"), "utf8")
      .trim()
      .split("\n")
      .map((line) => line.split(/\s+/) as [string, string]);
    expect(listing.map(([, path]) => path).sort()).toEqual(
      ["emitPart", "pin"]
        .flatMap((circuit) => [
          `keys/${circuit}.prover`,
          `keys/${circuit}.verifier`,
          `zkir/${circuit}.bzkir`,
          `zkir/${circuit}.zkir`,
        ])
        .sort(),
    );
    for (const [circuit, key] of Object.entries(BOARD_VERIFIER_KEYS)) {
      expect(listing.find(([, path]) => path === `keys/${circuit}.verifier`)?.[0]).toBe(sha(key));
    }
  });
});

describe("the board's notice format (its own processing)", () => {
  it("round-trips a notice through its padded parts and refuses non-zero padding", () => {
    const text = "Pinned: the board opens at nine. ".repeat(12);
    const request = noticeRequest(address, SECRET, text);
    expect(request.parts).toHaveLength(2);
    const merged = new Uint8Array(512);
    request.parts.forEach((part, index) => merged.set(part, index * 256));
    expect(decodeNotice(merged)).toBe(text);
    expect(encodeNotice("").byteLength).toBe(4);
    merged[511] = 1;
    expect(() => decodeNotice(merged)).toThrow(/padding is not zero/);
  });
});

describe("packages through the public entry points", () => {
  it("a notice package verifies with the board's (contract, name); the board's state is unchanged", async () => {
    const text = "x".repeat(700);
    const before = chain.state.index(address)?.serialize();
    const built = await buildPackageTransaction(
      chain.source(),
      configFor(),
      noticeRequest(address, SECRET, text),
    );
    const erased = built.transaction.eraseProofs();
    const result = chain.apply(erased);
    expect(result.type).toBe("success");
    expect(chain.state.index(address)?.serialize()).toEqual(before);
    const events = partEventsFromLedgerEvents(result.events, { network: NETWORK }).events;
    const [pkg] = readPackages(events, { optIns: [boardOptIn(address)] }).packages;
    expect(pkg?.nameText).toBe("notice-board:notice[v1]");
    expect(pkg?.parts).toHaveLength(3);
    expect(decodeNotice(pkg?.payload ?? new Uint8Array())).toBe(text);
    // The reference emitter's name is another name: nothing to read under it here.
    expect(readPackages(events, { optIns: [{ contract: address, name: EXAMPLE_NAME }] })).toEqual({
      packages: [],
      ignored: 3,
    });
    const raw = verifyTransactionPackages(erased, {
      ...boardPlacement(address),
      network: NETWORK,
      status: statusFromLedgerResult(result.type),
      transactionHash: result.events[0]?.source.transactionHash ?? "",
    });
    expect(raw.verified).toHaveLength(1);
  });

  it("a board package and a reference-emitter package in one transaction: each reader sees only its own", async () => {
    const secret = filled32(0x42);
    const emitter = await deployEmitter(chain, secret);
    const built = await buildPackagesTransaction(chain.source(), configFor(), [
      noticeRequest(address, SECRET, "board notice"),
      requestFor(emitter, emitterBinding(secret), [new Uint8Array(256).fill(7)]),
    ]);
    const result = chain.apply(built.transaction.eraseProofs());
    expect(result.type).toBe("success");
    const events = partEventsFromLedgerEvents(result.events, { network: NETWORK }).events;
    const boardRead = readPackages(events, { optIns: [boardOptIn(address)] });
    const emitterRead = readPackages(events, {
      optIns: [{ contract: emitter, name: EXAMPLE_NAME }],
    });
    expect([boardRead.packages.length, boardRead.ignored]).toEqual([1, 1]);
    expect([emitterRead.packages.length, emitterRead.ignored]).toEqual([1, 1]);
    expect(decodeNotice(boardRead.packages[0]?.payload ?? new Uint8Array())).toBe("board notice");
  });

  it("pin changes the board's state in its own transaction; a stranger cannot pin or publish", async () => {
    const digest = Uint8Array.from(createHash("sha256").update("x".repeat(700)).digest());
    const target = { network: NETWORK, address, coinPublicKey: COIN_PUBLIC_KEY };
    const result = chain.apply(
      (await buildPinTransaction(chain.source(), target, SECRET, digest)).eraseProofs(),
    );
    expect(result.type).toBe("success");
    const view = readBoard(
      RuntimeContractState.deserialize(chain.state.index(address)?.serialize() ?? new Uint8Array())
        .data,
    );
    expect(view.pinnedCount).toBe(1n);
    expect(view.pinnedDigest).toEqual(digest);
    await expect(
      buildPinTransaction(chain.source(), target, filled32(0x43), digest),
    ).rejects.toThrow(/caller is not the emitter authority/);
    await expect(
      buildPackageTransaction(
        chain.source(),
        configFor(),
        noticeRequest(address, filled32(0x43), "no"),
      ),
    ).rejects.toThrow(/caller is not the emitter authority/);
  });
});

describe("offline demo", () => {
  it("publishes one package, then two packages in one transaction, reads and verifies them, and pins", async () => {
    const report = await runOfflineDemo();
    expect(
      report.transactions.map((entry) => [entry.intents, entry.packages, entry.stateUnchanged]),
    ).toEqual([
      [1, 1, true],
      [2, 2, true],
    ]);
    const notices = report.transactions.flatMap((entry) => entry.notices);
    expect(notices.map((notice) => notice.parts)).toEqual([1, 3, 1]);
    for (const notice of notices) {
      expect(notice.fromEvents).toBe("accepted, notice equal");
      expect(notice.fromRawTransaction).toBe("guaranteed-only placement, notice equal");
    }
    expect(new Set(report.transactions[1]?.notices.map((notice) => notice.segment)).size).toBe(2);
    expect(report.refusals).toHaveLength(1);
    expect(report.refusals[0]).toMatch(/caller is not the emitter authority/);
    expect(report.pinnedCount).toBe("1");
    expect(report.pinnedDigestIsNoticeSha256).toBe(true);
  });
});
