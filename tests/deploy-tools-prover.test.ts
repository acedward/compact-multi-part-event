/**
 * deploy-tools' prover client: retry classification, the concurrency limit, bounded retries on
 * 408/429/connection resets, refusal of anything but a proven ledger-v9 transaction of
 * this process, and the explicit wrong-assignment test: a provider with another seam
 * shape is rejected by the type checker and, if forced through a cast, fails at its
 * stage before the wallet or the network is ever asked.
 */
import { httpClientProofProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import { NodeZkConfigProvider } from "@midnight-ntwrk/midnight-js-node-zk-config-provider";
import * as ledger from "@midnightntwrk/ledger-v9";
import { beforeAll, describe, expect, it } from "vitest";

import {
  limitedProvingEndpoint,
  ProverAnswerError,
  proverFromEndpoint,
  requireProvenTransaction,
  retryableProofError,
  type ProvingEndpoint,
  type RetryEvent,
} from "../deploy-tools/prover.js";
import {
  buildPackageTransaction,
  type BuiltTransaction,
  finalizeTransactionPackages,
  PackageCheckError,
  type PublicationBalancer,
  type PublicationProver,
} from "../src/publisher/index.js";
import { filled32, patternParts } from "./helpers/bytes.js";
import {
  configFor,
  deployEmitter,
  emitterBinding,
  LocalChain,
  NETWORK,
  requestFor,
} from "./helpers/ledger.js";
import { emitterInitialState } from "./helpers/generated.js";

type Unbound = ledger.Transaction<ledger.SignatureEnabled, ledger.Proof, ledger.PreBinding>;

const statusError = (status: number): Error =>
  new Error(
    `Failed Proof Server response: url="http://127.0.0.1:1/prove", code="${String(status)}", status="x"`,
  );

describe("retry classification", () => {
  it.each([
    [statusError(408), "HTTP 408"],
    [statusError(429), "HTTP 429"],
    [statusError(502), "HTTP 502"],
    [statusError(504), "HTTP 504"],
    [Object.assign(new Error("request failed"), { code: "ECONNRESET" }), "ECONNRESET"],
    [new Error("fetch failed", { cause: { code: "UND_ERR_SOCKET" } }), "UND_ERR_SOCKET"],
    [new Error("request to http://x failed, reason: socket hang up"), "connection reset"],
  ])("retries %s", (error, reason) => {
    expect(retryableProofError(error)).toBe(reason);
  });

  it.each([statusError(400), statusError(500), statusError(503), new Error("invalid proof input")])(
    "does not retry %s",
    (error) => {
      expect(retryableProofError(error)).toBeUndefined();
    },
  );
});

/** A fake proof server endpoint that records concurrency and fails as scripted. */
const fakeEndpoint = (script: (call: number) => Error | undefined, delayMs = 5) => {
  let inFlight = 0;
  let maxInFlight = 0;
  let calls = 0;
  const handle = async <T>(value: T): Promise<T> => {
    calls += 1;
    const call = calls;
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolveWait) => setTimeout(resolveWait, delayMs));
    inFlight -= 1;
    const error = script(call);
    if (error !== undefined) throw error;
    return value;
  };
  const endpoint: ProvingEndpoint = {
    check: () => handle<(bigint | undefined)[]>([]),
    prove: () => handle(new Uint8Array([1])),
    lookupKey: () => Promise.resolve(undefined),
  };
  return {
    endpoint,
    stats: () => ({ calls, maxInFlight }),
  };
};

describe("concurrency limit and bounded retries", () => {
  it("never has more than maxConcurrent requests in flight", async () => {
    const fake = fakeEndpoint(() => undefined);
    const provider = limitedProvingEndpoint(fake.endpoint, { maxConcurrent: 3 })(1000);
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        index % 2 === 0
          ? provider.prove(new Uint8Array(), "k")
          : provider.check(new Uint8Array(), "k"),
      ),
    );
    expect(fake.stats()).toEqual({ calls: 20, maxInFlight: 3 });
  });

  it("retries 429 and 408 with backoff, then succeeds", async () => {
    const fake = fakeEndpoint((call) =>
      call === 1 ? statusError(429) : call === 2 ? statusError(408) : undefined,
    );
    const retries: RetryEvent[] = [];
    const sleeps: number[] = [];
    const provider = limitedProvingEndpoint(fake.endpoint, {
      baseDelayMs: 100,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      onRetry: (event) => retries.push(event),
    })(1000);
    await expect(provider.prove(new Uint8Array(), "k")).resolves.toEqual(new Uint8Array([1]));
    expect(sleeps).toEqual([100, 200]);
    expect(retries.map((event) => event.reason)).toEqual(["HTTP 429", "HTTP 408"]);
  });

  it("gives up after maxAttempts and throws the last error; non-retryable errors are not retried", async () => {
    const always = fakeEndpoint(() => statusError(429));
    const provider = limitedProvingEndpoint(always.endpoint, {
      maxAttempts: 3,
      sleep: () => Promise.resolve(),
    })(1000);
    await expect(provider.check(new Uint8Array(), "k")).rejects.toThrow('code="429"');
    expect(always.stats().calls).toBe(3);

    const bad = fakeEndpoint(() => statusError(400));
    const once = limitedProvingEndpoint(bad.endpoint, { sleep: () => Promise.resolve() })(1000);
    await expect(once.prove(new Uint8Array(), "k")).rejects.toThrow('code="400"');
    expect(bad.stats().calls).toBe(1);
  });
});

describe("answers", () => {
  let unprovenDeploy: ledger.UnprovenTransaction;

  beforeAll(async () => {
    const state = await emitterInitialState(filled32(0x44));
    unprovenDeploy = ledger.Transaction.fromParts(
      NETWORK,
      undefined,
      undefined,
      ledger.Intent.new(new Date(Date.now() + 600_000)).addDeploy(
        new ledger.ContractDeploy(ledger.ContractState.deserialize(state.serialize())),
      ),
    );
  });

  it("proves a transaction without calls without asking the proof server, and accepts the proven answer", async () => {
    const fake = fakeEndpoint(() => new Error("must not be called"));
    const prover = proverFromEndpoint(fake.endpoint);
    const proven = await prover.proveTx(unprovenDeploy);
    expect(proven).toBeInstanceOf(ledger.Transaction);
    expect(fake.stats().calls).toBe(0);
    expect(requireProvenTransaction(proven)).toBe(proven);
  });

  it("refuses version-tagged payloads, bytes, foreign objects and unproven transactions", () => {
    expect(() => requireProvenTransaction({ version: "v9", tx: unprovenDeploy })).toThrow(
      /version-tagged payload/,
    );
    expect(() => requireProvenTransaction(new Uint8Array([1, 2]))).toThrow(/serialized bytes/);
    expect(() => requireProvenTransaction({ intents: new Map() })).toThrow(/ledger-v9 module/);
    expect(() => requireProvenTransaction(unprovenDeploy)).toThrow(ProverAnswerError);
  });
});

describe("wrong direct assignment of a provider to the publisher's seams", () => {
  /** The shape of a version-tagged proof provider (midnight-js 5.0.0-beta.8 style). */
  interface TaggedProofProvider {
    proveTx(
      payload: { readonly version: "v9"; readonly tx: ledger.UnprovenTransaction },
      config?: { readonly timeout?: number },
    ): Promise<{ readonly version: "v9"; readonly tx: Unbound }>;
  }

  const tagged: TaggedProofProvider = {
    proveTx: (payload) => Promise.resolve({ version: "v9", tx: payload.tx as unknown as Unbound }),
  };

  it("does not type-check (the assignment below is expected to be an error)", () => {
    // @ts-expect-error - a version-tagged seam is not a PublicationProver
    const wrong: PublicationProver = tagged;
    expect(typeof wrong.proveTx).toBe("function");
    // midnight-js 5.0.0-beta.7's own ProofProvider has the composer's plain-object shape;
    // it type-checks, but it would bypass the adapter's concurrency limit and retries.
    const plain: PublicationProver = httpClientProofProvider(
      "http://127.0.0.1:9",
      new NodeZkConfigProvider("/nonexistent"),
    );
    expect(typeof plain.proveTx).toBe("function");
  });

  describe("forced through a cast, it fails at its stage", () => {
    let chain: LocalChain;
    let built: BuiltTransaction;

    beforeAll(async () => {
      chain = new LocalChain();
      const secret = filled32(0x21);
      const emitter = await deployEmitter(chain, secret);
      built = await buildPackageTransaction(
        chain.source(),
        configFor(),
        requestFor(emitter, emitterBinding(secret), patternParts(3, 2)),
      );
    });

    const failure = async (run: () => Promise<unknown>): Promise<Error> => {
      try {
        await run();
      } catch (error) {
        return error as Error;
      }
      throw new Error("accepted");
    };

    it("a tagged prover: refused after proving, the wallet is never asked", async () => {
      let balanced = 0;
      const balancer: PublicationBalancer = {
        balanceTx: () => {
          balanced += 1;
          return Promise.reject(new Error("unreachable"));
        },
      };
      const wronglyWired = {
        proveTx: (tx: ledger.UnprovenTransaction) => tagged.proveTx({ version: "v9", tx }),
      } as unknown as PublicationProver;
      const error = await failure(() =>
        finalizeTransactionPackages({ prover: wronglyWired, balancer }, built, {
          proofTimeoutMs: 1000,
          requireProofs: false,
        }),
      );
      expect(error).toBeInstanceOf(PackageCheckError);
      expect(error.message).toMatch(/^after proving: the prover returned a version-tagged payload/);
      expect(balanced).toBe(0);
    });

    it("a prover answering bytes: refused after proving", async () => {
      const bytesProver = {
        proveTx: (tx: ledger.UnprovenTransaction) => Promise.resolve(tx.serialize()),
      } as unknown as PublicationProver;
      const error = await failure(() =>
        finalizeTransactionPackages(
          { prover: bytesProver, balancer: { balanceTx: () => Promise.reject(new Error("x")) } },
          built,
          { proofTimeoutMs: 1000, requireProofs: false },
        ),
      );
      expect(error.message).toMatch(/^after proving: the prover returned serialized bytes/);
    });

    it("a tagged balancer: refused after balancing, nothing is recorded", async () => {
      const identity = {
        proveTx: (tx: ledger.UnprovenTransaction) => Promise.resolve(tx as unknown as Unbound),
      } as PublicationProver;
      const taggedBalancer = {
        balanceTx: (tx: Unbound) =>
          Promise.resolve({
            version: "v9",
            tx: (tx as unknown as ledger.UnprovenTransaction).bind(),
          }),
      } as unknown as PublicationBalancer;
      const error = await failure(() =>
        finalizeTransactionPackages({ prover: identity, balancer: taggedBalancer }, built, {
          proofTimeoutMs: 1000,
          requireProofs: false,
        }),
      );
      expect(error.message).toMatch(
        /^after balancing: the balancer returned a version-tagged payload/,
      );
    });
  });
});
