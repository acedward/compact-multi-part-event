/**
 * Third-party merges (ported from the soundness audit's merge follow-up, offline with
 * erased proofs; the real-proof test repeats the PARTIAL_SUCCESS case with proven,
 * bound transactions). Verification looks only at the expected emitter's calls:
 * foreign intents do not change the result, and a failing foreign fallible segment
 * (transaction status PARTIAL_SUCCESS) still leaves the publication accepted.
 */
import * as ledger from "@midnightntwrk/ledger-v9";
import { beforeAll, describe, expect, it } from "vitest";

import { encodePublication, ReadStatus } from "../src/codec/index.js";
import {
  statusFromLedgerResult,
  verifyPublicationTransaction,
} from "../src/codec/raw-transaction.js";
import {
  assertPublicationIntent,
  buildPublicationTransaction,
  type BuiltPublication,
  finalizePublication,
  locatePublication,
} from "../src/transaction/index.js";
import { filled32, patternMessage } from "./helpers/bytes.js";
import {
  assembleIntent,
  configFor,
  deployEmitter,
  emitterBinding,
  emitterTrace,
  LocalChain,
  NETWORK,
  starve,
  transcriptsAt,
} from "./helpers/ledger.js";

const OURS = filled32(0x71);
const FOREIGN = filled32(0x72);
let chain: LocalChain;
let emitter: string;
let foreignEmitter: string;

const build = async (
  secret: Uint8Array,
  address: string,
  length: number,
  seed: number,
): Promise<BuiltPublication> => {
  for (;;) {
    const built = await buildPublicationTransaction(
      chain.source(),
      emitterBinding(secret),
      configFor(address),
      encodePublication(patternMessage(length, seed)),
    );
    if (built.expected.segment !== 65535) return built; // keep 65535 free for the attacker
  }
};

/** A foreign intent at segment 65535 whose only call is fallible and runs out of gas. */
const failingForeignIntent = async (): Promise<ledger.UnprovenTransaction> => {
  const foreign = await build(FOREIGN, foreignEmitter, 10, 3);
  const [transcript] = transcriptsAt(foreign.transaction, foreign.expected.segment);
  const [tail] = foreign.expected.tails;
  if (transcript === undefined || tail === undefined) throw new Error("no foreign call");
  const trace = await emitterTrace(
    chain,
    foreignEmitter,
    FOREIGN,
    foreign.expected.requestId,
    tail,
  );
  return assembleIntent(chain, foreignEmitter, 65535, [{ trace, fallible: starve(transcript) }]);
};

const applyOnFork = (tx: ledger.UnprovenTransaction) => {
  const fork = chain.fork();
  const erased = tx.eraseProofs();
  const result = fork.apply(erased);
  return { erased, result };
};

const verifyOurs = (
  tx: ledger.Transaction<ledger.Signaturish, ledger.Proofish, ledger.Bindingish>,
  status: string,
  hash: string,
) =>
  verifyPublicationTransaction(tx, {
    emitter,
    entryPoint: "emitPart",
    network: NETWORK,
    status,
    transactionHash: hash,
  });

beforeAll(async () => {
  chain = new LocalChain();
  emitter = await deployEmitter(chain, OURS);
  foreignEmitter = await deployEmitter(chain, FOREIGN);
});

describe("third-party merges", () => {
  it("a foreign guaranteed intent (another contract) does not change our verification", async () => {
    const ours = await build(OURS, emitter, 417, 1);
    const foreign = await build(FOREIGN, foreignEmitter, 300, 2);
    const merged = ours.transaction.merge(foreign.transaction);
    expect(merged.intents?.size).toBe(2);
    // The publisher's own checks look only at its intent, so an honest merge passes.
    expect(() => {
      assertPublicationIntent(merged, ours.expected, "merged");
    }).not.toThrow();
    const { erased, result } = applyOnFork(merged);
    expect(result.type).toBe("success");
    expect(result.events).toHaveLength(5);
    const report = verifyOurs(
      erased,
      statusFromLedgerResult(result.type),
      result.events[0]?.source.transactionHash ?? "",
    );
    expect(report.issues).toEqual([]);
    expect(report.emissions).toHaveLength(3);
    expect(report.accepted).toHaveLength(1);
    expect(report.accepted[0]?.message).toEqual(patternMessage(417, 1));
  });

  it("a failing foreign fallible segment gives PARTIAL_SUCCESS; the publication is still accepted", async () => {
    const ours = await build(OURS, emitter, 624, 4);
    const merged = ours.transaction.merge(await failingForeignIntent());
    const { erased, result } = applyOnFork(merged);
    expect(result.type).toBe("partialSuccess");
    expect(result.events).toHaveLength(3); // our three parts; the foreign call failed
    const hash = result.events[0]?.source.transactionHash ?? "";
    const accepted = verifyOurs(erased, statusFromLedgerResult(result.type), hash);
    expect(accepted.issues).toEqual([]);
    expect(accepted.accepted).toHaveLength(1);
    expect(accepted.accepted[0]?.message).toEqual(patternMessage(624, 4));
    // FAILURE never lands on chain; if a source reported it, nothing is accepted.
    expect(verifyOurs(erased, "FAILURE", hash).accepted).toHaveLength(0);
  });

  it("our emitter's entry point called from another intent: the publisher refuses it before submission", async () => {
    const ours = await build(OURS, emitter, 300, 5);
    const second = await build(OURS, emitter, 100, 6);
    const merged = ours.transaction.merge(second.transaction);
    expect(() => {
      assertPublicationIntent(merged, ours.expected, "merged");
    }).toThrow(/also calls the emitter's emitPart/);
    // Two different messages in one transaction are two groups for the reader.
    const { erased, result } = applyOnFork(merged);
    const report = verifyOurs(
      erased,
      statusFromLedgerResult(result.type),
      result.events[0]?.source.transactionHash ?? "",
    );
    expect(report.read.results.map((entry) => entry.status)).toEqual([
      ReadStatus.Complete,
      ReadStatus.Complete,
    ]);
  });

  it("a merged transaction is found by the publication's identifiers and intent, not its hash", async () => {
    const ours = await build(OURS, emitter, 417, 7);
    const record = await finalizePublication(
      {
        prover: { proveTx: (tx) => Promise.resolve(tx as never) },
        balancer: {
          balanceTx: (tx) =>
            Promise.resolve((tx as unknown as ledger.UnprovenTransaction).bind() as never),
        },
      },
      ours,
      { proofTimeoutMs: 1000, requireProofs: false },
    );
    const bound = ledger.Transaction.deserialize(
      "signature",
      "pre-proof",
      "binding",
      Buffer.from(record.transactionHex, "hex"),
    );
    const foreign = (await failingForeignIntent()).bind();
    const merged = bound.merge(foreign);
    expect(locatePublication(bound, record)).toEqual({ contains: true, merged: false });
    expect(locatePublication(merged, record)).toEqual({ contains: true, merged: true });
    const other = await build(OURS, emitter, 417, 8);
    expect(locatePublication(other.transaction.bind(), record).contains).toBe(false);
  });
});
