/**
 * Offline demo of the consumer example on a local ledger (no network, no wallet):
 *
 *   deploy the board -> two owners register their notices, each in its own transaction
 *   -> each owner publishes its notice as one aggregate guaranteed-only transaction
 *   built by the library's composer -> the public reader rebuilds both notices from the
 *   ledger's events and from the raw transactions -> the application step `announce`
 *   and the owner-only `release` run in later transactions.
 *
 * It also shows what the registration prevents: nobody else can register a notice that
 * is already registered, or emit parts of a notice they do not own.
 *
 * Run: node examples/consumer/dist/offline-demo.js (after compiling the example).
 */
import { createConstructorContext } from "@midnight-ntwrk/compact-runtime";
import { ContractState as RuntimeContractState } from "@midnight-ntwrk/compact-runtime";
import * as ledger from "@midnightntwrk/ledger-v9";
import { encodePublication, readPublications, ReadStatus } from "compact-multi-segment-emit/codec";
import {
  publicEventsFromLedgerEvents,
  statusFromLedgerResult,
  verifyPublicationTransaction,
} from "compact-multi-segment-emit/codec/raw-transaction";
import {
  buildCircuitCallTransaction,
  buildDeployTransaction,
  buildPublicationTransaction,
} from "compact-multi-segment-emit/transaction";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  announcePlan,
  board,
  boardBinding,
  type BoardCallTarget,
  ownerCommitment,
  readBoard,
  registrationPlan,
  releasePlan,
} from "./board.js";
import { LocalLedger } from "./local-ledger.js";

const NETWORK = "consumer-demo";
const COIN_PUBLIC_KEY = "0".repeat(64);
const PROVABLE = [
  "announce",
  "emitPart",
  "register1",
  "register2",
  "register3",
  "register5",
  "release",
];

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

/** The committed verifier keys of the board (examples/consumer/keys). */
export const boardVerifierKeys = (): Record<string, Uint8Array> =>
  Object.fromEntries(
    PROVABLE.map((circuit) => [
      circuit,
      new Uint8Array(readFileSync(new URL(`../keys/${circuit}.verifier`, import.meta.url))),
    ]),
  );

/** A deterministic notice of `length` bytes. */
export const notice = (length: number, seed: number): Uint8Array =>
  Uint8Array.from({ length }, (_, index) => (index * 31 + seed) & 0xff);

/** What the demo observed. */
export interface DemoReport {
  readonly board: string;
  readonly publications: readonly {
    readonly owner: string;
    readonly requestId: string;
    readonly parts: number;
    readonly bytes: number;
    readonly fromEvents: string;
    readonly fromRawTransaction: string;
    readonly stateUnchangedByPublication: boolean;
  }[];
  readonly refusals: readonly string[];
  readonly announcements: bigint;
  readonly latestAnnouncement: string;
  readonly releasedStillRegistered: boolean;
}

const refusal = async (label: string, run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    return `${label}: ${error instanceof Error ? error.message : String(error)}`;
  }
  throw new Error(`${label}: unexpectedly accepted`);
};

/** Run the whole flow and report what happened. */
export const runOfflineDemo = async (): Promise<DemoReport> => {
  const local = new LocalLedger(NETWORK);
  const initial = await board().initialState(
    createConstructorContext({ messageOwnerSecret: new Uint8Array(32) }, COIN_PUBLIC_KEY),
  );
  const deploy = buildDeployTransaction({
    network: NETWORK,
    initialState: initial.currentContractState,
    verifierKeys: boardVerifierKeys(),
    maintenanceCommittee: [ledger.signatureVerifyingKey(ledger.sampleSigningKey())],
    ttl: new Date(local.time.getTime() + 10 * 60 * 1000),
  });
  if (local.apply(deploy.transaction).type !== "success") throw new Error("deploy failed");
  const target: BoardCallTarget = {
    network: NETWORK,
    address: deploy.address,
    coinPublicKey: COIN_PUBLIC_KEY,
  };
  const boardState = () =>
    RuntimeContractState.deserialize(
      local.state.index(deploy.address)?.serialize() ?? new Uint8Array(),
    );

  const owners = [
    { name: "alice", secret: Uint8Array.from(randomBytes(32)), message: notice(417, 7) },
    { name: "bob", secret: Uint8Array.from(randomBytes(32)), message: notice(1000, 11) },
  ];
  const publicationsOf = owners.map((owner) => encodePublication(owner.message));

  // 1. Each owner registers in its own, earlier transaction.
  for (const [index, owner] of owners.entries()) {
    const publication = publicationsOf[index];
    if (publication === undefined) throw new Error("no publication");
    const built = await buildCircuitCallTransaction(
      local.source(),
      registrationPlan(target, publication, owner.secret),
    );
    const result = local.apply(built.transaction);
    if (result.type !== "success") throw new Error(`registration failed: ${String(result.error)}`);
    const stored = readBoard(boardState().data).ownerOf(publication.requestId);
    if (stored === undefined || hex(stored) !== hex(ownerCommitment(owner.secret))) {
      throw new Error("registry entry missing");
    }
  }
  const [alice, bob] = owners;
  const [alicePublication, bobPublication] = publicationsOf;
  if (
    alice === undefined ||
    bob === undefined ||
    alicePublication === undefined ||
    bobPublication === undefined
  ) {
    throw new Error("demo setup");
  }

  // What the registration prevents.
  const refusals = [
    await refusal("bob registers alice's notice", () =>
      buildCircuitCallTransaction(
        local.source(),
        registrationPlan(target, alicePublication, bob.secret),
      ),
    ),
    await refusal("bob emits parts of alice's notice", () =>
      buildPublicationTransaction(
        local.source(),
        boardBinding(bob.secret),
        { network: NETWORK, emitter: deploy.address, coinPublicKey: COIN_PUBLIC_KEY },
        alicePublication,
      ),
    ),
    await refusal("bob releases alice's notice", () =>
      buildCircuitCallTransaction(
        local.source(),
        releasePlan(target, alicePublication.requestId, bob.secret),
      ),
    ),
  ];

  // 2. Each owner publishes: one aggregate guaranteed-only transaction per notice.
  const publications = [];
  for (const [index, owner] of owners.entries()) {
    const publication = publicationsOf[index];
    if (publication === undefined) throw new Error("no publication");
    const before = local.state.index(deploy.address)?.serialize();
    const built = await buildPublicationTransaction(
      local.source(),
      boardBinding(owner.secret),
      { network: NETWORK, emitter: deploy.address, coinPublicKey: COIN_PUBLIC_KEY },
      publication,
    );
    const result = local.apply(built.transaction);
    if (result.type !== "success") throw new Error(`publication failed: ${String(result.error)}`);
    const after = local.state.index(deploy.address)?.serialize();

    // 3a. Read back from the ledger's events with the public reader.
    const events = publicEventsFromLedgerEvents(result.events, {
      network: NETWORK,
      emitter: deploy.address,
      entryPoint: "emitPart",
    });
    const read = readPublications(events.events).results;
    const fromEvents =
      read.length === 1 &&
      read[0]?.status === ReadStatus.Complete &&
      hex(read[0].message ?? new Uint8Array()) === hex(owner.message)
        ? "Complete, message equal"
        : `unexpected: ${JSON.stringify(read.map((entry) => entry.status))}`;

    // 3b. Verify from the raw transaction, as a wallet-free verifier does.
    const report = verifyPublicationTransaction(built.transaction.eraseProofs().serialize(), {
      emitter: deploy.address,
      entryPoint: "emitPart",
      network: NETWORK,
      status: statusFromLedgerResult(result.type),
      transactionHash: result.events[0]?.source.transactionHash ?? "",
    });
    const fromRawTransaction =
      report.issues.length === 0 &&
      hex(report.accepted[0]?.message ?? new Uint8Array()) === hex(owner.message)
        ? "accepted, guaranteed-only placement"
        : `unexpected: ${report.issues.join("; ")}`;
    publications.push({
      owner: owner.name,
      requestId: hex(publication.requestId),
      parts: publication.parts.length,
      bytes: owner.message.byteLength,
      fromEvents,
      fromRawTransaction,
      stateUnchangedByPublication:
        before !== undefined && after !== undefined && hex(before) === hex(after),
    });
  }

  // 4. Application step and cleanup, each in its own later transaction.
  for (const plan of [
    announcePlan(target, alicePublication.requestId, alice.secret),
    releasePlan(target, alicePublication.requestId, alice.secret),
  ]) {
    const built = await buildCircuitCallTransaction(local.source(), plan);
    const result = local.apply(built.transaction);
    if (result.type !== "success")
      throw new Error(`${plan.circuit} failed: ${String(result.error)}`);
  }
  const view = readBoard(boardState().data);
  return {
    board: deploy.address,
    publications,
    refusals,
    announcements: view.announcements,
    latestAnnouncement: hex(view.latestAnnouncement),
    releasedStillRegistered: view.ownerOf(alicePublication.requestId) !== undefined,
  };
};

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const report = await runOfflineDemo();
  console.log(
    JSON.stringify(
      report,
      (_, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
      2,
    ),
  );
}
