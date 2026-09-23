/**
 * Transaction composer: configuration and preflight (before any provider access),
 * one pinned snapshot, circuit time in seconds, TTL, the segment-0 rebuild, the
 * injected binding (including misbehaving bindings), every publication-intent check,
 * finalize with stand-in providers that mutate what they return, and submission of
 * exactly the saved bytes.
 */
import {
  type CallProofData,
  type CircuitContext,
  ContractState as RuntimeContractState,
  createCircuitContext,
} from "@midnight-ntwrk/compact-runtime";
import { encodeContractKeyLocation, hashVerifierKey } from "@midnight-ntwrk/midnight-js-types";
import * as ledger from "@midnightntwrk/ledger-v9";
import { beforeAll, describe, expect, it } from "vitest";

import type { EmitterPrivateState } from "../src/contract/index.js";
import { encodePublication, type EncodedPublication } from "../src/codec/index.js";
import {
  assertPublicationIntent,
  blockFullnessCheck,
  buildPublicationTransaction,
  type BuiltPublication,
  canonicalKeyLocation,
  type EmissionBinding,
  finalizePublication,
  type FinalizedPublication,
  type PublicationBalancer,
  PublicationCheckError,
  type PublicationProver,
  retryUntilNonZeroSegment,
  submitPublication,
} from "../src/transaction/index.js";
import { filled32, patternMessage, toHex } from "./helpers/bytes.js";
import { COIN_PUBLIC_KEY, EMITTER_VERIFIER_KEY } from "./helpers/generated.js";
import {
  assembleIntent,
  type CallSpec,
  configFor,
  deployEmitter,
  emitterBinding,
  emitterTrace,
  LocalChain,
  NETWORK,
  starve,
  transcriptsAt,
} from "./helpers/ledger.js";

type Transcript = ledger.Transcript<ledger.AlignedValue>;
type Proven = ledger.Transaction<ledger.SignatureEnabled, ledger.Proof, ledger.PreBinding>;

const SECRET = filled32(0x81);
const OTHER = filled32(0x82);
let chain: LocalChain;
let emitter: string;
let foreignEmitter: string;
let publication: EncodedPublication;
let built: BuiltPublication;
let transcripts: Transcript[];
let traces: CallProofData[];

const threw = (run: () => unknown): string => {
  try {
    run();
    return "accepted";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

const rejects = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
    return "accepted";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

const specs = (
  parts: readonly number[],
  override?: (part: number) => Partial<CallSpec>,
): CallSpec[] =>
  parts.map((part) => {
    const trace = traces[part];
    if (trace === undefined) throw new Error("no trace");
    return { trace, guaranteed: transcripts[part], ...override?.(part) };
  });

const at = (segment = built.expected.segment, parts: CallSpec[] = specs([0, 1, 2])) =>
  assembleIntent(chain, emitter, segment, parts);

/** Rebuild the publication intent after changing it (unbound intents are writable). */
const withIntent = (
  change: (
    intent: ledger.Intent<ledger.SignatureEnabled, ledger.PreProof, ledger.PreBinding>,
  ) => void,
): ledger.UnprovenTransaction => {
  const intent = at().intents?.get(built.expected.segment);
  if (intent === undefined) throw new Error("no intent");
  change(intent);
  return ledger.Transaction.fromParts(NETWORK).addIntent(
    { tag: "specific", value: built.expected.segment },
    intent,
  );
};

const check = (
  tx: ledger.UnprovenTransaction,
  expected = built.expected,
  frozen?: readonly Transcript[],
) =>
  threw(() => {
    assertPublicationIntent(tx, expected, "test", frozen);
  });

const passThrough: PublicationProver = {
  proveTx: (tx) => Promise.resolve(tx as unknown as Proven),
};
const binder: PublicationBalancer = {
  balanceTx: (tx) => Promise.resolve((tx as unknown as ledger.UnprovenTransaction).bind() as never),
};
const offline = { proofTimeoutMs: 1000, requireProofs: false } as const;

beforeAll(async () => {
  chain = new LocalChain();
  emitter = await deployEmitter(chain, SECRET);
  foreignEmitter = await deployEmitter(chain, OTHER);
  publication = encodePublication(patternMessage(417, 11));
  built = await buildPublicationTransaction(
    chain.source(),
    emitterBinding(SECRET),
    configFor(emitter),
    publication,
  );
  transcripts = transcriptsAt(built.transaction, built.expected.segment);
  traces = await Promise.all(
    publication.parts.map((part) =>
      emitterTrace(chain, emitter, SECRET, publication.requestId, part.tail),
    ),
  );
});

describe("configuration and preflight happen before any provider access", () => {
  const counted = () => {
    const before = { blocks: chain.latestBlockCalls, states: chain.stateCalls.length };
    return () => ({
      blocks: chain.latestBlockCalls - before.blocks,
      states: chain.stateCalls.length - before.states,
    });
  };

  it.each([
    ["empty network", { network: "" }, /network/],
    ["uppercase emitter", { emitter: "AB".repeat(32) }, /emitter/],
    ["short emitter", { emitter: "ab" }, /emitter/],
    ["zero parts", { maxParts: 0 }, /maxParts/],
    ["1000 parts", { maxParts: 1000 }, /maxParts/],
    [
      "message limit above the part limit",
      { maxParts: 2, maxMessageBytes: 417 },
      /maxMessageBytes/,
    ],
    ["TTL above its bound", { ttlSeconds: 7200 }, /ttlSeconds/],
    ["no assembly attempts", { maxAssemblyAttempts: 0 }, /maxAssemblyAttempts/],
    ["empty coin public key", { coinPublicKey: "" }, /coinPublicKey/],
  ])("rejects %s", async (_, overrides, pattern) => {
    const calls = counted();
    const message = await rejects(() =>
      buildPublicationTransaction(
        chain.source(),
        emitterBinding(SECRET),
        configFor(emitter, overrides),
        publication,
      ),
    );
    expect(message).toMatch(pattern);
    expect(calls()).toEqual({ blocks: 0, states: 0 });
  });

  it("rejects over-cap, non-canonical, reordered and inconsistent publications", async () => {
    const calls = counted();
    const nine = encodePublication(patternMessage(9 * 208 - 5), {
      maxMessageBytes: 9 * 208,
      maxParts: 9,
    });
    const tampered: EncodedPublication = {
      ...publication,
      parts: publication.parts.map((part, index) =>
        index === 1
          ? { ...part, tail: part.tail.map((byte, i) => (i === 50 ? byte ^ 1 : byte)) }
          : part,
      ),
    };
    const reordered: EncodedPublication = {
      ...publication,
      parts: [...publication.parts].reverse(),
    };
    const inconsistent: EncodedPublication = { ...publication, messageLength: 416 };
    const cases: [EncodedPublication, RegExp][] = [
      [nine, /9 parts; the configured limit is 8/],
      [tampered, /not complete and canonical/],
      [reordered, /is not part 1 of 3/],
      [inconsistent, /message length disagrees/],
    ];
    for (const [input, pattern] of cases) {
      expect(
        await rejects(() =>
          buildPublicationTransaction(
            chain.source(),
            emitterBinding(SECRET),
            configFor(emitter),
            input,
          ),
        ),
      ).toMatch(pattern);
    }
    expect(calls()).toEqual({ blocks: 0, states: 0 });
    // The cap is configurable up to the format ceiling.
    await expect(
      buildPublicationTransaction(
        chain.source(),
        emitterBinding(SECRET),
        configFor(emitter, { maxParts: 9 }),
        nine,
      ),
    ).resolves.toBeDefined();
  });
});

describe("one pinned snapshot, block time in seconds, TTL", () => {
  it("reads one block and one state at that block; runs every part at the block's time", async () => {
    const seen: bigint[] = [];
    const base = emitterBinding(SECRET);
    const recording: EmissionBinding<EmitterPrivateState> = {
      ...base,
      emitPart: (context: CircuitContext<EmitterPrivateState>, requestId, tail) => {
        seen.push(context.callContext.currentQueryContext.block.secondsSinceEpoch);
        return base.emitPart(context, requestId, tail);
      },
    };
    const blocksBefore = chain.latestBlockCalls;
    const statesBefore = chain.stateCalls.length;
    const result = await buildPublicationTransaction(
      chain.source(),
      recording,
      configFor(emitter, { ttlSeconds: 900 }),
      publication,
    );
    expect(chain.latestBlockCalls - blocksBefore).toBe(1);
    expect(chain.stateCalls.slice(statesBefore)).toEqual([
      { address: emitter, blockHash: chain.parentBlockHash },
    ]);
    expect(seen).toEqual([BigInt(chain.seconds), BigInt(chain.seconds), BigInt(chain.seconds)]);
    expect(result.block).toEqual({
      hash: chain.parentBlockHash,
      height: chain.height,
      timestampSeconds: chain.seconds,
    });
    expect(result.ttl.getTime()).toBe((chain.seconds + 900) * 1000);
    expect(result.transaction.intents?.get(result.expected.segment)?.ttl.getTime()).toBe(
      result.ttl.getTime(),
    );
    expect(result.expected.segment).toBeGreaterThan(0);
  });

  it("uses the configured key-location resolver with the deployed verifier key", async () => {
    const inputs: { address: string; entryPoint: string; verifierKey: Uint8Array }[] = [];
    await buildPublicationTransaction(
      chain.source(),
      emitterBinding(SECRET),
      configFor(emitter, {
        keyLocation: (input) => {
          inputs.push(input);
          return canonicalKeyLocation(input);
        },
      }),
      publication,
    );
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.address).toBe(emitter);
    expect(inputs[0]?.entryPoint).toBe("emitPart");
    expect(inputs[0]?.verifierKey).toEqual(EMITTER_VERIFIER_KEY);
  });

  it("the default key location matches midnight-js's canonical encoder", () => {
    const location = canonicalKeyLocation({
      address: emitter,
      entryPoint: "emitPart",
      verifierKey: EMITTER_VERIFIER_KEY,
    });
    expect(location).toBe(
      encodeContractKeyLocation({
        contractAddress: emitter,
        circuitId: "emitPart",
        verifierKeyHash: hashVerifierKey(EMITTER_VERIFIER_KEY),
      }),
    );
    expect(() =>
      canonicalKeyLocation({
        address: emitter.toUpperCase(),
        entryPoint: "emitPart",
        verifierKey: EMITTER_VERIFIER_KEY,
      }),
    ).toThrow();
    expect(() =>
      canonicalKeyLocation({
        address: emitter,
        entryPoint: "a/b",
        verifierKey: EMITTER_VERIFIER_KEY,
      }),
    ).toThrow();
  });

  it("rebuilds when the ledger draws segment 0", () => {
    const draws = [0, 0, 7];
    const result = retryUntilNonZeroSegment(
      () => draws.shift() ?? 9,
      (value) => value,
      5,
    );
    expect(result).toEqual({ value: 7, segment: 7, attempts: 3 });
    expect(() =>
      retryUntilNonZeroSegment(
        () => 0,
        (value) => value,
        4,
      ),
    ).toThrow(/segment 0 in all 4 attempts/);
  });
});

describe("the injected binding", () => {
  const build = (binding: EmissionBinding<EmitterPrivateState>) =>
    rejects(() =>
      buildPublicationTransaction(chain.source(), binding, configFor(emitter), publication),
    );
  const base = () => emitterBinding(SECRET);

  it("a binding for another contract instance does not match the emitter", async () => {
    expect(
      await build({ ...base(), createPrivateState: () => ({ emitterSecret: OTHER }) }),
    ).toMatch(/caller is not the emitter authority/);
  });

  it("refuses emitted bytes that differ from the part", async () => {
    const binding = base();
    expect(
      await build({
        ...binding,
        emitPart: (context, requestId, tail) =>
          binding.emitPart(
            context,
            requestId,
            tail.map((b, i) => (i === 60 ? b ^ 1 : b)),
          ),
      }),
    ).toMatch(/execution: part 1: emitted bytes differ from the part/);
  });

  it("refuses two executions per part and executions without a trace", async () => {
    const binding = base();
    expect(
      await build({
        ...binding,
        emitPart: async (context, requestId, tail) => {
          const first = await binding.emitPart(context, requestId, tail);
          return binding.emitPart(first.context, requestId, tail);
        },
      }),
    ).toMatch(/execution: part 1: (produced 2 call traces|emitted 2 events)/);
    expect(
      await build({
        ...binding,
        emitPart: (context) =>
          Promise.resolve({
            result: [],
            context: { ...context, events: [], callProofDataTrace: [] },
            gasCost: context.callContext.currentGasCost,
          }),
      }),
    ).toMatch(/produced 0 call traces/);
  });

  it("refuses an execution against another contract address", async () => {
    const binding = base();
    const foreignState = chain.state.index(foreignEmitter);
    if (foreignState === undefined) throw new Error("no foreign emitter");
    expect(
      await build({
        ...binding,
        createPrivateState: () => ({ emitterSecret: OTHER }),
        emitPart: (_context, requestId, tail) =>
          binding.emitPart(
            createCircuitContext(
              "emitPart",
              foreignEmitter,
              COIN_PUBLIC_KEY,
              RuntimeContractState.deserialize(foreignState.serialize()),
              { emitterSecret: OTHER },
            ),
            requestId,
            tail,
          ),
      }),
    ).toMatch(/trace targets another contract/);
  });
});

describe("publication-intent checks (one case per rule)", () => {
  it("accepts the assembled transaction and a faithful re-assembly", () => {
    expect(check(built.transaction, built.expected, built.frozenTranscripts)).toBe("accepted");
    expect(check(at(), built.expected, built.frozenTranscripts)).toBe("accepted");
  });

  it.each([
    [
      "no parts expected",
      () => check(at(), { ...built.expected, tails: [] }),
      /expected part count 0/,
    ],
    ["segment 0", () => check(at(), { ...built.expected, segment: 0 }), /not in 1\.\.65535/],
    [
      "no intent at the segment",
      () => check(at(), { ...built.expected, segment: (built.expected.segment % 65000) + 1 }),
      /no intent at publication segment/,
    ],
    [
      "a missing part",
      () => check(at(built.expected.segment, specs([0, 1]))),
      /has 2 actions, expected 3/,
    ],
    [
      "an extra part",
      () => check(at(built.expected.segment, specs([0, 1, 2, 2]))),
      /has 4 actions, expected 3/,
    ],
    [
      "another contract",
      () => check(at(), { ...built.expected, emitter: foreignEmitter }),
      /targets another contract/,
    ],
    [
      "another entry point",
      () => check(at(), { ...built.expected, entryPoint: "other" }),
      /uses another entry point/,
    ],
    [
      "a demoted (fallible) part",
      () =>
        check(
          at(built.expected.segment, [
            ...specs([0, 1]),
            ...specs([2], () => ({ guaranteed: undefined, fallible: transcripts[2] })),
          ]),
        ),
      /call 3 has a fallible transcript/,
    ],
    [
      "other bytes than expected",
      () => check(at(), { ...built.expected, tails: [...built.expected.tails].reverse() }),
      /call 1 emits bytes other than part 1/,
    ],
    [
      "a changed transcript (gas)",
      () =>
        check(
          at(
            built.expected.segment,
            specs([0, 1, 2], (p) =>
              p === 0 ? { guaranteed: starve(transcripts[0] as Transcript) } : {},
            ),
          ),
          built.expected,
          built.frozenTranscripts,
        ),
      /call 1 guaranteed transcript changed/,
    ],
    [
      "a transcript without a log",
      () =>
        check(
          at(
            built.expected.segment,
            specs([0, 1, 2], (p) =>
              p === 1
                ? {
                    guaranteed: {
                      ...(transcripts[1] as Transcript),
                      program: (transcripts[1] as Transcript).program.slice(0, -1),
                    },
                  }
                : {},
            ),
          ),
        ),
      /call 2 transcript: transcript logs 0 events/,
    ],
    [
      "a non-Misc event",
      () =>
        check(
          at(
            built.expected.segment,
            specs([0, 1, 2], (p) =>
              p === 2 ? { guaranteed: retype(transcripts[2] as Transcript) } : {},
            ),
          ),
        ),
      /call 3 logs a non-Misc event/,
    ],
    [
      "an unshielded offer",
      () =>
        check(
          withIntent((intent) => {
            intent.guaranteedUnshieldedOffer = ledger.UnshieldedOffer.new([], [], []);
          }),
        ),
      /carries an unshielded offer/,
    ],
    [
      "DUST actions",
      () =>
        check(
          withIntent((intent) => {
            intent.dustActions = new ledger.DustActions("signature", "pre-proof", chain.time);
          }),
        ),
      /carries DUST actions/,
    ],
  ])("refuses %s", (_, run, pattern) => {
    expect(run()).toMatch(pattern);
  });

  it("refuses a non-call action in the publication intent", () => {
    const tx = withIntent(() => undefined);
    const intent = assembleIntent(
      chain,
      emitter,
      built.expected.segment,
      specs([0, 1]),
    ).intents?.get(built.expected.segment);
    const state = chain.state.index(emitter);
    if (intent === undefined || state === undefined) throw new Error("setup");
    const withDeploy = intent.addDeploy(new ledger.ContractDeploy(state));
    const replaced = ledger.Transaction.fromParts(NETWORK).addIntent(
      { tag: "specific", value: built.expected.segment },
      withDeploy,
    );
    expect(check(replaced)).toMatch(/call 3 is not a contract call/);
    expect(check(tx)).toBe("accepted");
  });

  it("refuses a fallible Zswap offer in the publication segment", () => {
    const output = ledger.ZswapOutput.new(
      ledger.createShieldedCoinInfo(ledger.sampleRawTokenType(), 1n),
      built.expected.segment,
      ledger.sampleCoinPublicKey(),
      ledger.sampleEncryptionPublicKey(),
    );
    const offer = ledger.ZswapOffer.fromOutput(output, ledger.sampleRawTokenType(), 1n);
    const tx = at().addZswapOffer({ tag: "specific", value: built.expected.segment }, offer);
    expect(tx.fallibleOffer?.get(built.expected.segment)).toBeDefined();
    expect(check(tx)).toMatch(/fallible Zswap offer/);
  });

  it("refuses another intent calling the emitter's entry point", async () => {
    const second = await buildPublicationTransaction(
      chain.source(),
      emitterBinding(SECRET),
      configFor(emitter),
      encodePublication(patternMessage(10)),
    );
    if (second.expected.segment === built.expected.segment) return;
    expect(check(built.transaction.merge(second.transaction))).toMatch(
      /also calls the emitter's emitPart/,
    );
  });
});

/** Change the logged item's type cell (index 1) to 11. */
function retype(transcript: Transcript): Transcript {
  return {
    ...transcript,
    program: transcript.program.map((op) => {
      if (typeof op === "string" || !("push" in op) || op.push.value.tag !== "array") return op;
      const content = op.push.value.content.map((item, index) =>
        index === 1 && item.tag === "cell"
          ? { ...item, content: { ...item.content, value: [Uint8Array.of(11)] } }
          : item,
      );
      return { push: { ...op.push, value: { ...op.push.value, content } } };
    }),
  };
}

describe("finalize with stand-in providers", () => {
  const counters = () => ({ prove: 0, balance: 0, ttl: [] as (Date | undefined)[] });

  const finalizeWith = (
    proveResult: () => ledger.UnprovenTransaction,
    balanceResult?: (tx: ledger.UnprovenTransaction) => ledger.UnprovenTransaction,
    options: Parameters<typeof finalizePublication>[2] = offline,
  ) => {
    const count = counters();
    const promise = finalizePublication(
      {
        prover: {
          proveTx: () => {
            count.prove += 1;
            return Promise.resolve(proveResult() as unknown as Proven);
          },
        },
        balancer: {
          balanceTx: (tx, ttl) => {
            count.balance += 1;
            count.ttl.push(ttl);
            const next =
              balanceResult?.(tx as unknown as ledger.UnprovenTransaction) ??
              (tx as unknown as ledger.UnprovenTransaction);
            return Promise.resolve(next.bind() as never);
          },
        },
      },
      built,
      options,
    );
    return { promise, count };
  };

  it("pass-through providers: one proof call, one balance call with the build TTL, a public record", async () => {
    const { promise, count } = finalizeWith(() => built.transaction);
    const record = await promise;
    expect(count).toEqual({ prove: 1, balance: 1, ttl: [built.ttl] });
    expect(record.segment).toBe(built.expected.segment);
    expect(record.requestIdHex).toBe(toHex(publication.requestId));
    expect(record.tailsHex).toEqual(publication.parts.map((part) => toHex(part.tail)));
    expect(record.identifiers.length).toBeGreaterThan(0);
    expect(record.intentHash).toMatch(/^[0-9a-f]+$/);
    expect(record.transactionHash).toBeNull(); // unproven stand-in: the ledger has no hash for it
    expect(record.ttl).toBe(built.ttl.toISOString());
    expect(JSON.parse(JSON.stringify(record))).toEqual(record);
  });

  it.each([
    [
      "rewrites one event byte",
      () =>
        at(
          built.expected.segment,
          specs([0, 1, 2], (p) =>
            p === 1 ? { guaranteed: retype(transcripts[1] as Transcript) } : {},
          ),
        ),
    ],
    [
      "demotes a part to fallible",
      () =>
        at(built.expected.segment, [
          ...specs([0, 1]),
          ...specs([2], () => ({ guaranteed: undefined, fallible: transcripts[2] })),
        ]),
    ],
    ["drops a part", () => at(built.expected.segment, specs([0, 1]))],
    ["adds a part", () => at(built.expected.segment, specs([0, 1, 2, 0]))],
    ["reorders parts", () => at(built.expected.segment, specs([1, 0, 2]))],
    [
      "changes a transcript's budget",
      () =>
        at(
          built.expected.segment,
          specs([0, 1, 2], (p) =>
            p === 2 ? { guaranteed: starve(transcripts[2] as Transcript) } : {},
          ),
        ),
    ],
    ["moves the publication to another segment", () => at((built.expected.segment % 65000) + 1)],
  ])("a prover that %s is refused after proving; the wallet is never asked", async (_, mutate) => {
    const { promise, count } = finalizeWith(mutate);
    const error = await rejects(() => promise);
    expect(error).toMatch(/^after proving: /);
    expect(count.balance).toBe(0);
  });

  it("a prover returning a consistent substitute publication is refused", async () => {
    const substitute = await buildPublicationTransaction(
      chain.source(),
      emitterBinding(SECRET),
      configFor(emitter),
      encodePublication(patternMessage(417, 12)),
    );
    const { promise } = finalizeWith(() => substitute.transaction);
    expect(await rejects(() => promise)).toMatch(/^after proving: /);
  });

  it("a wallet that changes the publication is refused after balancing; an honest foreign merge passes", async () => {
    const demoted = finalizeWith(
      () => built.transaction,
      () =>
        at(built.expected.segment, [
          ...specs([0, 1]),
          ...specs([2], () => ({ guaranteed: undefined, fallible: transcripts[2] })),
        ]),
    );
    expect(await rejects(() => demoted.promise)).toMatch(
      /^after balancing: call 3 has a fallible transcript/,
    );

    const foreign = await buildPublicationTransaction(
      chain.source(),
      emitterBinding(OTHER),
      configFor(foreignEmitter),
      encodePublication(patternMessage(20)),
    );
    if (foreign.expected.segment === built.expected.segment) return;
    const merged = finalizeWith(
      () => built.transaction,
      (tx) => tx.merge(foreign.transaction),
    );
    const record = await merged.promise;
    expect(record.segment).toBe(built.expected.segment);

    const second = await buildPublicationTransaction(
      chain.source(),
      emitterBinding(SECRET),
      configFor(emitter),
      encodePublication(patternMessage(30)),
    );
    if (second.expected.segment === built.expected.segment) return;
    const addsOurs = finalizeWith(
      () => built.transaction,
      (tx) => tx.merge(second.transaction),
    );
    expect(await rejects(() => addsOurs.promise)).toMatch(
      /^after balancing: .*also calls the emitter's emitPart/,
    );
  });

  it("runs the cost hook after proving and after balancing", async () => {
    const stages: string[] = [];
    const { promise } = finalizeWith(() => built.transaction, undefined, {
      ...offline,
      costCheck: (_tx, _params, stage) => {
        stages.push(stage);
      },
    });
    await promise;
    expect(stages).toEqual(["after proving", "after balancing"]);
    const strict = finalizeWith(() => built.transaction, undefined, {
      ...offline,
      costCheck: blockFullnessCheck(1e-9),
    });
    expect(await rejects(() => strict.promise)).toMatch(
      /^after proving: .* of a block \(limit 1e-9\)/,
    );
    expect(strict.count.balance).toBe(0);
    const fits = finalizeWith(() => built.transaction, undefined, {
      ...offline,
      costCheck: blockFullnessCheck(1),
    });
    await expect(fits.promise).resolves.toBeDefined();
  });

  it("requires proven, bound bytes unless told otherwise, and a valid timeout", async () => {
    const proofs = finalizeWith(() => built.transaction, undefined, { proofTimeoutMs: 1000 });
    expect(await rejects(() => proofs.promise)).toMatch(
      /^after serialization: bytes are not a proven, bound transaction/,
    );
    const timeout = finalizeWith(() => built.transaction, undefined, {
      proofTimeoutMs: 0,
      requireProofs: false,
    });
    expect(await rejects(() => timeout.promise)).toMatch(/proofTimeoutMs/);
    expect(timeout.count.prove).toBe(0);
  });
});

describe("submission of the saved bytes", () => {
  let record: FinalizedPublication;
  beforeAll(async () => {
    record = await finalizePublication({ prover: passThrough, balancer: binder }, built, offline);
  });

  const submitWith = async (changed: FinalizedPublication, options = { requireProofs: false }) => {
    const submitted: ledger.FinalizedTransaction[] = [];
    const message = await rejects(() =>
      submitPublication(
        {
          submitTx: (tx) => {
            submitted.push(tx);
            return Promise.resolve("tx-id");
          },
        },
        changed,
        options,
      ),
    );
    return { message, submitted };
  };

  it("submits exactly the saved bytes, once", async () => {
    const { message, submitted } = await submitWith(record);
    expect(message).toBe("accepted");
    expect(submitted).toHaveLength(1);
    expect(toHex(submitted[0]?.serialize() ?? new Uint8Array())).toBe(record.transactionHex);
  });

  it.each([
    [
      "an event byte changed in the saved bytes",
      (r: FinalizedPublication) => {
        // Every copy of these tail bytes (event cell and proof input) is changed.
        const needle = (r.tailsHex[1] ?? "").slice(40, 80);
        const flipped =
          needle.slice(0, 3) +
          (Number.parseInt(needle[3] ?? "0", 16) ^ 1).toString(16) +
          needle.slice(4);
        expect(r.transactionHex.includes(needle)).toBe(true);
        return { ...r, transactionHex: r.transactionHex.split(needle).join(flipped) };
      },
      /before submission|not a ledger-v9 transaction/,
    ],
    [
      "a different recorded hash",
      (r: FinalizedPublication) => ({ ...r, transactionHash: "00".repeat(32) }),
      /recorded transaction hash/,
    ],
    [
      "a missing identifier",
      (r: FinalizedPublication) => ({ ...r, identifiers: r.identifiers.slice(1) }),
      /recorded identifiers/,
    ],
    [
      "a different intent hash",
      (r: FinalizedPublication) => ({ ...r, intentHash: "00".repeat(32) }),
      /recorded intent hash/,
    ],
    [
      "a different expected tail",
      (r: FinalizedPublication) => ({ ...r, tailsHex: [...r.tailsHex].reverse() }),
      /before submission: call 1 emits bytes other than part 1/,
    ],
    [
      "another segment",
      (r: FinalizedPublication) => ({ ...r, segment: (r.segment % 65000) + 1 }),
      /before submission: no intent/,
    ],
  ])("refuses %s without submitting", async (_, change, pattern) => {
    const { message, submitted } = await submitWith(change(record));
    expect(message).toMatch(pattern);
    expect(submitted).toHaveLength(0);
  });

  it("refuses unproven bytes by default", async () => {
    const { message, submitted } = await submitWith(record, { requireProofs: true });
    expect(message).toMatch(/not a proven, bound transaction/);
    expect(submitted).toHaveLength(0);
  });

  it("names the stage in its errors", () => {
    const error = new PublicationCheckError("after proving", "detail");
    expect(error.message).toBe("after proving: detail");
    expect(error.stage).toBe("after proving");
  });
});
