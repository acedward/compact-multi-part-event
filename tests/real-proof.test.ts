/**
 * Opt-in end-to-end run with real proofs from a local proof server (ported from the
 * soundness audit, B3 and the merge follow-up). Requires:
 *   PROOF_SERVER_URL   e.g. http://<prefix>-proof-server:6300
 *   ZK_ARTIFACTS_DIR   directory with keys/ and zkir/ for emitPart (npm run compile:zk →
 *                      build/zk/emitter); its verifier key must equal the committed one
 * Optional: PROVE_LIMIT_AT=33,34 proves those part counts and reports whether the
 * default cost check accepts them (several minutes each).
 *
 * The local ledger applies the proven transactions with balancing and signatures
 * relaxed. It does not verify proofs (the published wasm build cannot), and this test
 * does not claim that it does: proof validity is established by inclusion on chain.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import * as ledger from "@midnightntwrk/ledger-v9";
import { describe, expect, it } from "vitest";

import { proofServerProver } from "../src/adapters/prover.js";
import { zkConfigForContract } from "../src/adapters/zk-config.js";
import { encodePublication } from "../src/codec/index.js";
import {
  statusFromLedgerResult,
  verifyPublicationTransaction,
} from "../src/codec/raw-transaction.js";
import {
  buildPublicationTransaction,
  finalizePublication,
  locatePublication,
  type PublicationBalancer,
  type PublicationProver,
  submitPublication,
} from "../src/transaction/index.js";
import { filled32, hashedBytes } from "./helpers/bytes.js";
import { EMITTER_VERIFIER_KEY } from "./helpers/generated.js";
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

const PROOF_SERVER_URL = process.env.PROOF_SERVER_URL ?? "";
const ZK_ARTIFACTS_DIR = process.env.ZK_ARTIFACTS_DIR ?? "";
const enabled = PROOF_SERVER_URL !== "" && ZK_ARTIFACTS_DIR !== "";
const TIMEOUT = 1_800_000;
const SECRET = filled32(0x91);
const FOREIGN = filled32(0x92);

type Proven = ledger.Transaction<ledger.SignatureEnabled, ledger.Proof, ledger.PreBinding>;

/**
 * The repository's prover adapter over midnight-js 5.0.0-beta.7's HTTP proving provider:
 * at most PROOF_CONCURRENCY (default 4) requests in flight, bounded retries on
 * 408/429/connection resets, and the answer checked to be a proven ledger-v9
 * transaction of this process.
 */
const prover = (): PublicationProver =>
  proofServerProver({
    url: PROOF_SERVER_URL,
    zkConfig: zkConfigForContract({
      artifactDir: ZK_ARTIFACTS_DIR,
      expectedVerifierKeys: { emitPart: EMITTER_VERIFIER_KEY },
    }),
    maxConcurrent: Number(process.env.PROOF_CONCURRENCY ?? "4"),
    onRetry: (event) => {
      record("prover-retry", { ...event });
    },
  });

/** Stand-in wallet: binds without adding a fee intent (no DUST in the local ledger). */
const binder: PublicationBalancer = { balanceTx: (tx) => Promise.resolve(tx.bind()) };

const record = (tag: string, value: Record<string, unknown>): void => {
  console.log(
    `[${tag}] ${JSON.stringify(value, (_, item: unknown) => (typeof item === "bigint" ? item.toString() : item))}`,
  );
};

describe.skipIf(!enabled)("real proofs through the composer, finalize and submit", () => {
  it("uses keys whose verifier key equals the committed one", () => {
    const generated = new Uint8Array(
      readFileSync(join(ZK_ARTIFACTS_DIR, "keys/emitPart.verifier")),
    );
    expect(generated).toEqual(EMITTER_VERIFIER_KEY);
  });

  it.each([
    { parts: 1, length: 208 },
    { parts: 2, length: 399 },
    { parts: 3, length: 624 },
    { parts: 8, length: 1647 },
  ])(
    "N=$parts: prove, bind, submit the saved bytes, apply, verify from raw bytes",
    async ({ parts, length }) => {
      const chain = new LocalChain();
      const emitter = await deployEmitter(chain, SECRET);
      const message = hashedBytes(length, `real-${String(parts)}`);
      const publication = encodePublication(message);
      expect(publication.parts).toHaveLength(parts);

      const buildStart = performance.now();
      const built = await buildPublicationTransaction(
        chain.source(),
        emitterBinding(SECRET),
        configFor(emitter),
        publication,
      );
      const buildMs = performance.now() - buildStart;
      const intentHashBefore = built.transaction.intents
        ?.get(built.expected.segment)
        ?.intentHash(built.expected.segment);

      let proveMs = 0;
      const base = prover();
      const timed: PublicationProver = {
        proveTx: async (tx, config) => {
          const start = performance.now();
          const proven = await base.proveTx(tx, config);
          proveMs = performance.now() - start;
          return proven;
        },
      };
      const saved = await finalizePublication({ prover: timed, balancer: binder }, built, {
        proofTimeoutMs: TIMEOUT,
      });
      expect(saved.transactionHash).toMatch(/^[0-9a-f]{64}$/);

      const submitted: ledger.FinalizedTransaction[] = [];
      const id = await submitPublication(
        {
          submitTx: (tx) => {
            submitted.push(tx);
            return Promise.resolve(tx.identifiers()[0] ?? "");
          },
        },
        saved,
      );
      expect(saved.identifiers).toContain(id);
      const snapshot = submitted[0];
      if (snapshot === undefined) throw new Error("nothing submitted");
      expect(Buffer.from(snapshot.serialize()).toString("hex")).toBe(saved.transactionHex);

      const params = chain.state.parameters;
      const cost = snapshot.cost(params, true);
      const normalized = params.normalizeFullness(cost);
      const fees = snapshot.fees(params);
      const result = chain.apply(snapshot);
      expect(result.type, String(result.error)).toBe("success");
      expect(result.events).toHaveLength(parts);

      const report = verifyPublicationTransaction(Buffer.from(saved.transactionHex, "hex"), {
        emitter,
        entryPoint: "emitPart",
        network: NETWORK,
        status: statusFromLedgerResult(result.type),
        transactionHash: saved.transactionHash ?? "",
      });
      expect(report.issues).toEqual([]);
      expect(report.accepted).toHaveLength(1);
      expect(report.accepted[0]?.message).toEqual(message);
      expect(locatePublication(snapshot, saved)).toEqual({ contains: true, merged: false });

      const provenBytes = saved.transactionHex.length / 2;
      const erasedBytes = snapshot.eraseProofs().serialize().byteLength;
      record("real-proof", {
        parts,
        messageBytes: length,
        buildMs: Math.round(buildMs),
        proveMs: Math.round(proveMs),
        provenBoundBytes: provenBytes,
        erasedBytes,
        proofBytesPerCall: Math.round((provenBytes - erasedBytes) / parts),
        normalizedBlockUsage: normalized.blockUsage,
        normalizedCompute: normalized.computeTime,
        fees,
        intentHashStableAcrossProveAndBind: intentHashBefore === saved.intentHash,
      });
    },
    TIMEOUT,
  );

  it(
    "a proven, bound foreign failing fallible intent merged in: PARTIAL_SUCCESS, still accepted and located",
    async () => {
      const chain = new LocalChain();
      const emitter = await deployEmitter(chain, SECRET);
      const foreignEmitter = await deployEmitter(chain, FOREIGN);
      const message = hashedBytes(624, "merge-victim");
      let built = await buildPublicationTransaction(
        chain.source(),
        emitterBinding(SECRET),
        configFor(emitter),
        encodePublication(message),
      );
      while (built.expected.segment === 65535) {
        built = await buildPublicationTransaction(
          chain.source(),
          emitterBinding(SECRET),
          configFor(emitter),
          encodePublication(message),
        );
      }
      const saved = await finalizePublication({ prover: prover(), balancer: binder }, built, {
        proofTimeoutMs: TIMEOUT,
      });

      const foreign = await buildPublicationTransaction(
        chain.source(),
        emitterBinding(FOREIGN),
        configFor(foreignEmitter),
        encodePublication(hashedBytes(10, "foreign")),
      );
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
      const attacker = assembleIntent(chain, foreignEmitter, 65535, [
        { trace, fallible: starve(transcript) },
      ]);
      const attackerFinal = (await prover().proveTx(attacker, { timeout: TIMEOUT })).bind();

      const ours = ledger.Transaction.deserialize(
        "signature",
        "proof",
        "binding",
        Buffer.from(saved.transactionHex, "hex"),
      );
      const merged = ours.merge(attackerFinal);
      const result = chain.apply(merged);
      expect(result.type).toBe("partialSuccess");
      const report = verifyPublicationTransaction(merged.serialize(), {
        emitter,
        entryPoint: "emitPart",
        network: NETWORK,
        status: statusFromLedgerResult(result.type),
        transactionHash: merged.transactionHash(),
      });
      expect(report.issues).toEqual([]);
      expect(report.accepted).toHaveLength(1);
      expect(report.accepted[0]?.message).toEqual(message);
      expect(locatePublication(merged, saved)).toEqual({ contains: true, merged: true });
      record("real-proof-merge", {
        result: result.type,
        events: result.events.length,
        mergedHashDiffers: merged.transactionHash() !== saved.transactionHash,
      });
    },
    TIMEOUT,
  );

  const limitAt = (process.env.PROVE_LIMIT_AT ?? "")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);

  it.skipIf(limitAt.length === 0)(
    "block fit: proves N parts and reports whether the default cost check accepts them",
    async () => {
      for (const parts of limitAt) {
        const chain = new LocalChain();
        const emitter = await deployEmitter(chain, SECRET);
        const message = hashedBytes(parts * 208, `limit-${String(parts)}`);
        const built = await buildPublicationTransaction(
          chain.source(),
          emitterBinding(SECRET),
          configFor(emitter, { maxParts: parts }),
          encodePublication(message, { maxMessageBytes: parts * 208, maxParts: parts }),
        );
        let proven: Proven | undefined;
        const start = performance.now();
        const outcome = await finalizePublication(
          {
            prover: {
              proveTx: async (tx, config) => {
                proven = await prover().proveTx(tx, config);
                return proven;
              },
            },
            balancer: binder,
          },
          built,
          { proofTimeoutMs: TIMEOUT },
        ).then(
          (saved) => ({ fits: true as const, saved }),
          (error: unknown) => ({
            fits: false as const,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        const finalizeMs = performance.now() - start;
        if (proven === undefined) {
          throw new Error(
            `proving ${String(parts)} parts failed: ${outcome.fits ? "no transaction" : outcome.error}`,
          );
        }
        const bound = proven.bind();
        const params = chain.state.parameters;
        const blockUsage = (() => {
          try {
            return params.normalizeFullness(bound.cost(params, true)).blockUsage;
          } catch (error) {
            return error instanceof Error ? error.message : String(error);
          }
        })();
        if (outcome.fits) {
          const snapshot = ledger.Transaction.deserialize(
            "signature",
            "proof",
            "binding",
            Buffer.from(outcome.saved.transactionHex, "hex"),
          );
          const result = chain.apply(snapshot);
          expect(result.type).toBe("success");
          const report = verifyPublicationTransaction(snapshot, {
            emitter,
            entryPoint: "emitPart",
            network: NETWORK,
            status: statusFromLedgerResult(result.type),
          });
          expect(report.accepted[0]?.message).toEqual(message);
        } else {
          expect(outcome.error).toMatch(/^after proving: /);
        }
        record("real-proof-limit", {
          parts,
          fits: outcome.fits,
          refusal: outcome.fits ? undefined : outcome.error,
          finalizeMs: Math.round(finalizeMs),
          provenBoundBytes: bound.serialize().byteLength,
          normalizedBlockUsage: blockUsage,
        });
      }
    },
    TIMEOUT,
  );
});
