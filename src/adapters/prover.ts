/**
 * Prover adapter over midnight-js's HTTP proving provider (proof server `/check` and
 * `/prove`).
 *
 * midnight-js 5.0.0-beta.7 sends every per-call request of a transaction at once and
 * retries only HTTP 500/503. A proof server has a bounded job queue (9.0.0-rc.6:
 * `--job-capacity` 10, then HTTP 429) and can answer 408 on a stale keep-alive
 * connection, so a publication of more parts than the queue holds, or a long run,
 * fails at proving for reasons unrelated to the transaction. This adapter limits
 * concurrent requests and retries 408, 429, 502, 504 and connection resets with
 * bounded exponential backoff. Every retry happens before anything is balanced or
 * submitted, so it is safe.
 *
 * The answer must be a proven, unbound ledger-v9 transaction from the same ledger
 * module; anything else (a version-tagged `{ version, tx }` object from a later
 * midnight-js, serialized bytes, a transaction of another ledger copy) is refused.
 *
 * The proof server receives the witness values of every call (for example the
 * emitter secret), so run it yourself, locally.
 *
 * @module
 */
import { httpClientProvingProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import type { ZKConfigProvider, ZKConfigRegistry } from "@midnight-ntwrk/midnight-js-types";
import * as ledger from "@midnightntwrk/ledger-v9";

import type { PublicationProver } from "../transaction/finalize.js";

/** A proven transaction waiting for the wallet to bind it. */
export type ProvenTransaction = ledger.Transaction<
  ledger.SignatureEnabled,
  ledger.Proof,
  ledger.PreBinding
>;

/** The `/check` + `/prove` provider shape the ledger's `Transaction.prove` drives. */
export interface ProvingEndpoint {
  check(
    serializedPreimage: Uint8Array,
    keyLocation: string,
    overrideTimeout?: number,
  ): Promise<(bigint | undefined)[]>;
  prove(
    serializedPreimage: Uint8Array,
    keyLocation: string,
    overwriteBindingInput?: bigint,
    overrideTimeout?: number,
  ): Promise<Uint8Array>;
  lookupKey(keyLocation: string): Promise<ledger.ProvingKeyMaterial | undefined>;
}

/** Retry and concurrency policy. */
export interface ProverPolicy {
  /** Largest number of `/check` and `/prove` requests in flight (default 4). */
  readonly maxConcurrent?: number;
  /** Attempts per request, including the first (default 5). */
  readonly maxAttempts?: number;
  /** First backoff in milliseconds; doubles per retry, capped at 30 s (default 1000). */
  readonly baseDelayMs?: number;
  /** Per-request timeout in milliseconds when `proveTx` gets none (default 600000). */
  readonly requestTimeoutMs?: number;
  /** Injectable sleep, for tests. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Called once per retry with a public description (no payload data). */
  readonly onRetry?: (event: RetryEvent) => void;
}

/** A retried request. */
export interface RetryEvent {
  readonly endpoint: "check" | "prove";
  readonly attempt: number;
  readonly delayMs: number;
  readonly reason: string;
}

/** The proof server answered something this adapter does not accept. */
export class ProverAnswerError extends Error {
  constructor(detail: string) {
    super(`prover answer refused: ${detail}`);
    this.name = "ProverAnswerError";
  }
}

const RETRYABLE_STATUS = new Set([408, 429, 502, 504]);
const RETRYABLE_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "ECONNABORTED",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

const errorCode = (error: unknown): string | undefined => {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
};

/**
 * Decide whether a failed proof-server request may be retried. midnight-js reports a
 * non-2xx answer as `Failed Proof Server response: url="…", code="<status>", …`.
 *
 * @returns A short public reason when the request is retryable, otherwise `undefined`.
 */
export const retryableProofError = (error: unknown): string | undefined => {
  const message = error instanceof Error ? error.message : String(error);
  const status = /code="(\d{3})"/.exec(message)?.[1];
  if (status !== undefined) {
    return RETRYABLE_STATUS.has(Number(status)) ? `HTTP ${status}` : undefined;
  }
  const code = errorCode(error);
  if (code !== undefined && RETRYABLE_CODES.has(code)) return code;
  if (/socket hang up|ECONNRESET|EPIPE|other side closed/i.test(message)) {
    return "connection reset";
  }
  return undefined;
};

/** A counting semaphore. */
const limiter = (max: number) => {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((resolveSlot) => waiting.push(resolveSlot));
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
};

const positive = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
};

/**
 * Wrap a proving endpoint with the concurrency limit and bounded retries.
 */
export const limitedProvingEndpoint = (
  endpoint: ProvingEndpoint,
  policy: ProverPolicy = {},
): ((timeoutMs: number) => ledger.ProvingProvider) => {
  const maxAttempts = positive(policy.maxAttempts ?? 5, "maxAttempts");
  const baseDelayMs = policy.baseDelayMs ?? 1000;
  const sleep =
    policy.sleep ??
    ((ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms)));
  const run = limiter(positive(policy.maxConcurrent ?? 4, "maxConcurrent"));
  const withRetry = async <T>(name: "check" | "prove", request: () => Promise<T>): Promise<T> => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await run(request);
      } catch (error) {
        const reason = retryableProofError(error);
        if (reason === undefined || attempt >= maxAttempts) throw error;
        const delayMs = Math.min(30_000, baseDelayMs * 2 ** (attempt - 1));
        policy.onRetry?.({ endpoint: name, attempt, delayMs, reason });
        await sleep(delayMs);
      }
    }
  };
  return (timeoutMs) => ({
    check: (preimage, keyLocation) =>
      withRetry("check", () => endpoint.check(preimage, keyLocation, timeoutMs)),
    prove: (preimage, keyLocation, overwriteBindingInput) =>
      withRetry("prove", () =>
        endpoint.prove(preimage, keyLocation, overwriteBindingInput, timeoutMs),
      ),
    lookupKey: (keyLocation) => endpoint.lookupKey(keyLocation),
  });
};

/**
 * Require a proven, unbound transaction of this process's ledger-v9 module.
 *
 * @throws {ProverAnswerError} For a version-tagged object, bytes, a transaction from
 * another ledger copy, or one that does not round-trip as proven and unbound.
 */
export const requireProvenTransaction = (answer: unknown): ProvenTransaction => {
  if (answer instanceof Uint8Array) {
    throw new ProverAnswerError("got serialized bytes, expected a live ledger-v9 transaction");
  }
  if (typeof answer === "object" && answer !== null && "version" in answer && "tx" in answer) {
    throw new ProverAnswerError(
      "got a version-tagged payload ({ version, tx }); this repository's seams carry plain ledger-v9 objects",
    );
  }
  if (!(answer instanceof ledger.Transaction)) {
    throw new ProverAnswerError(
      "not a transaction of this process's @midnightntwrk/ledger-v9 module",
    );
  }
  const proven = answer as ProvenTransaction;
  try {
    ledger.Transaction.deserialize("signature", "proof", "pre-binding", proven.serialize());
  } catch (error) {
    throw new ProverAnswerError(
      `the transaction is not proven and unbound (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  return proven;
};

/**
 * Prove through any proving endpoint with the concurrency limit and retries, and check
 * the answer.
 */
export const proverFromEndpoint = (
  endpoint: ProvingEndpoint,
  policy: ProverPolicy = {},
): PublicationProver => {
  const providerFor = limitedProvingEndpoint(endpoint, policy);
  const defaultTimeout = positive(policy.requestTimeoutMs ?? 600_000, "requestTimeoutMs");
  return {
    proveTx: async (tx, config) => {
      if (!(tx instanceof ledger.Transaction)) {
        throw new ProverAnswerError("input is not a ledger-v9 transaction of this process");
      }
      const proven: unknown = await tx.prove(
        providerFor(config?.timeout ?? defaultTimeout),
        ledger.CostModel.initialCostModel(),
      );
      return requireProvenTransaction(proven);
    },
  };
};

/** Options for {@link proofServerProver}. */
export interface ProofServerProverOptions extends ProverPolicy {
  /** Proof server base URL, e.g. `http://127.0.0.1:6300`. */
  readonly url: string;
  /** Key material for the contract's circuits (see `./zk-config`). */
  readonly zkConfig: ZKConfigProvider<string> | ZKConfigRegistry;
}

/**
 * A {@link PublicationProver} backed by a proof server through midnight-js's HTTP
 * proving provider.
 */
export const proofServerProver = (options: ProofServerProverOptions): PublicationProver =>
  proverFromEndpoint(
    httpClientProvingProvider(options.url, options.zkConfig, {
      timeout: options.requestTimeoutMs ?? 600_000,
    }),
    options,
  );
