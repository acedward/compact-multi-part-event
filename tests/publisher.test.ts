/**
 * The publisher: splitting, configuration and preflight (before any provider
 * access), one pinned snapshot, circuit time in seconds, TTL, segment redraws, the
 * injected binding (including misbehaving bindings), every package-intent check (other
 * intents ignored, including same-contract ones), several packages per transaction
 * (one intent each), finalize with stand-in providers that change what they return,
 * and submission of exactly the saved bytes.
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

import type { EmitterPrivateState } from "../contract-examples/whitelist/whitelist.js";
import {
  addGuaranteedIntent,
  assertPackageIntent,
  assertTransactionPackages,
  blockFullnessCheck,
  buildPackagesTransaction,
  buildPackageTransaction,
  type BuiltTransaction,
  canonicalKeyLocation,
  type EmissionBinding,
  type ExpectedPackage,
  finalizeTransactionPackages,
  type FinalizedRecord,
  PackageCheckError,
  type PublicationBalancer,
  type PublicationProver,
  splitPayload,
  submitRecord,
} from "../src/publisher/index.js";
import { eventName } from "../src/reader/index.js";
import { filled32, patternMessage, patternParts, toHex } from "./helpers/bytes.js";
import { COIN_PUBLIC_KEY, EMITTER_VERIFIER_KEY, EXAMPLE_NAME } from "./helpers/generated.js";
import {
  assembleIntent,
  type CallSpec,
  configFor,
  deployEmitter,
  emitterBinding,
  intentAt,
  LocalChain,
  NETWORK,
  requestFor,
  starve,
  traceOf,
  transcriptsAt,
} from "./helpers/ledger.js";

type Transcript = ledger.Transcript<ledger.AlignedValue>;
type Proven = ledger.Transaction<ledger.SignatureEnabled, ledger.Proof, ledger.PreBinding>;

const SECRET = filled32(0x81);
const OTHER = filled32(0x82);
let chain: LocalChain;
let emitter: string;
let foreignEmitter: string;
let parts: Uint8Array[];
let built: BuiltTransaction;
let expected: ExpectedPackage;
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
  indexes: readonly number[],
  override?: (index: number) => Partial<CallSpec>,
): CallSpec[] =>
  indexes.map((index) => {
    const trace = traces[index];
    if (trace === undefined) throw new Error("no trace");
    return { trace, guaranteed: transcripts[index], ...override?.(index) };
  });

const at = (segment = expected.segment, calls: CallSpec[] = specs([0, 1, 2])) =>
  assembleIntent(chain, emitter, segment, calls);

/** Rebuild the package intent after changing it (unbound intents are writable). */
const withIntent = (
  change: (
    intent: ledger.Intent<ledger.SignatureEnabled, ledger.PreProof, ledger.PreBinding>,
  ) => void,
): ledger.UnprovenTransaction => {
  const intent = at().intents?.get(expected.segment);
  if (intent === undefined) throw new Error("no intent");
  change(intent);
  return ledger.Transaction.fromParts(NETWORK).addIntent(
    { tag: "specific", value: expected.segment },
    intent,
  );
};

const check = (tx: ledger.UnprovenTransaction, pkg = expected, frozen?: readonly Transcript[]) =>
  threw(() => {
    assertPackageIntent(tx, pkg, "test", frozen);
  });

const build = (secret: Uint8Array, address: string, count: number, seed: number) =>
  buildPackageTransaction(
    chain.source(),
    configFor(),
    requestFor(address, emitterBinding(secret), patternParts(count, seed)),
  );

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
  parts = patternParts(3, 11);
  built = await buildPackageTransaction(
    chain.source(),
    configFor(),
    requestFor(emitter, emitterBinding(SECRET), parts),
  );
  const [first] = built.packages;
  if (first === undefined) throw new Error("no package");
  expected = first;
  transcripts = transcriptsAt(built.transaction, expected.segment);
  traces = await Promise.all(
    parts.map((part) => traceOf(chain, emitter, emitterBinding(SECRET), part)),
  );
});

describe("splitting a payload into 256-byte parts", () => {
  it("zero-pads the last part and refuses an empty payload", () => {
    expect(splitPayload(new Uint8Array([1, 2, 3]))).toEqual([
      Uint8Array.from([1, 2, 3, ...new Uint8Array(253)]),
    ]);
    const payload = patternMessage(513, 1);
    const split = splitPayload(payload);
    expect(split.map((part) => part.byteLength)).toEqual([256, 256, 256]);
    expect(Buffer.concat(split).subarray(0, 513)).toEqual(Buffer.from(payload));
    expect(split[2]?.subarray(1)).toEqual(new Uint8Array(255));
    expect(splitPayload(patternMessage(512)).length).toBe(2);
    expect(() => splitPayload(new Uint8Array())).toThrow(/empty/);
  });
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
    ["zero parts cap", { maxParts: 0 }, /maxParts/],
    ["a cap above the ceiling", { maxParts: 1025 }, /maxParts/],
    ["TTL above its bound", { ttlSeconds: 7200 }, /ttlSeconds/],
    ["no assembly attempts", { maxAssemblyAttempts: 0 }, /maxAssemblyAttempts/],
    ["empty coin public key", { coinPublicKey: "" }, /coinPublicKey/],
  ])("rejects %s", async (_, overrides, pattern) => {
    const calls = counted();
    const message = await rejects(() =>
      buildPackageTransaction(
        chain.source(),
        configFor(overrides),
        requestFor(emitter, emitterBinding(SECRET), parts),
      ),
    );
    expect(message).toMatch(pattern);
    expect(calls()).toEqual({ blocks: 0, states: 0 });
  });

  it("rejects bad requests: contract, name, part count and part widths", async () => {
    const calls = counted();
    const binding = emitterBinding(SECRET);
    const cases: [Parameters<typeof requestFor>, RegExp][] = [
      [[emitter.toUpperCase(), binding, parts], /64 lowercase hex/],
      [[emitter, binding, parts, ""], /must not be empty/],
      [[emitter, binding, parts, "x".repeat(33)], /longer than 32 bytes/],
      [[emitter, binding, []], /0 parts; the configured limit is 1\.\.8/],
      [[emitter, binding, patternParts(9)], /9 parts; the configured limit is 1\.\.8/],
      [[emitter, binding, [new Uint8Array(255)]], /part 1 is 255 bytes, not 256/],
      [[emitter, { ...binding, entryPoint: "" }, parts], /no entry point/],
    ];
    for (const [args, pattern] of cases) {
      expect(
        await rejects(() =>
          buildPackageTransaction(chain.source(), configFor(), requestFor(...args)),
        ),
      ).toMatch(pattern);
    }
    expect(await rejects(() => buildPackagesTransaction(chain.source(), configFor(), []))).toMatch(
      /1\.\.16 packages/,
    );
    expect(calls()).toEqual({ blocks: 0, states: 0 });
    // The cap is configurable.
    await expect(
      buildPackageTransaction(
        chain.source(),
        configFor({ maxParts: 9 }),
        requestFor(emitter, binding, patternParts(9)),
      ),
    ).resolves.toBeDefined();
  });
});

describe("one pinned snapshot, block time in seconds, TTL, segments", () => {
  it("reads one block and one state at that block; runs every part at the block's time", async () => {
    const seen: bigint[] = [];
    const base = emitterBinding(SECRET);
    const recording: EmissionBinding<EmitterPrivateState> = {
      ...base,
      emitPart: (context: CircuitContext<EmitterPrivateState>, payload) => {
        seen.push(context.callContext.currentQueryContext.block.secondsSinceEpoch);
        return base.emitPart(context, payload);
      },
    };
    const blocksBefore = chain.latestBlockCalls;
    const statesBefore = chain.stateCalls.length;
    const result = await buildPackageTransaction(
      chain.source(),
      configFor({ ttlSeconds: 900 }),
      requestFor(emitter, recording, parts),
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
    const [pkg] = result.packages;
    expect(result.transaction.intents?.get(pkg?.segment ?? 0)?.ttl.getTime()).toBe(
      result.ttl.getTime(),
    );
    expect(pkg?.segment).toBeGreaterThan(0);
    expect(pkg?.name).toEqual(eventName(EXAMPLE_NAME));
    expect(result.transaction.intents?.size).toBe(1);
  });

  it("uses the configured key-location resolver with the deployed verifier key", async () => {
    const inputs: { address: string; entryPoint: string; verifierKey: Uint8Array }[] = [];
    await buildPackageTransaction(
      chain.source(),
      configFor({
        keyLocation: (input) => {
          inputs.push(input);
          return canonicalKeyLocation(input);
        },
      }),
      requestFor(emitter, emitterBinding(SECRET), parts),
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

  it("redraws a segment of 0 or a segment that already holds an intent", () => {
    // A transaction whose addCalls always lands on a taken segment, then on segment 0,
    // then on a fresh one: only the fresh draw is accepted.
    const base = at();
    const draws = [expected.segment, 0, 4242];
    const fake = {
      intents: base.intents,
      addCalls: () => {
        const segment = draws.shift() ?? 1;
        const intents = new Map(base.intents);
        if (!intents.has(segment))
          intents.set(segment, base.intents?.get(expected.segment) as never);
        return { intents } as unknown as ledger.UnprovenTransaction;
      },
    } as unknown as ledger.UnprovenTransaction;
    const result = addGuaranteedIntent(fake, () => [], chain.state.parameters, new Date(), 5);
    expect(result.segment).toBe(4242);
    expect(result.attempts).toBe(3);
    const stuck = {
      intents: base.intents,
      addCalls: () => ({ intents: base.intents }) as unknown as ledger.UnprovenTransaction,
    } as unknown as ledger.UnprovenTransaction;
    expect(() =>
      addGuaranteedIntent(stuck, () => [], chain.state.parameters, new Date(), 4),
    ).toThrow(/segment 0 or a taken segment in all 4 attempts/);
  });
});

describe("the injected binding", () => {
  const buildWith = (binding: EmissionBinding<EmitterPrivateState>) =>
    rejects(() =>
      buildPackageTransaction(chain.source(), configFor(), requestFor(emitter, binding, parts)),
    );
  const base = () => emitterBinding(SECRET);

  it("a binding with another secret fails the whitelist during execution", async () => {
    expect(
      await buildWith({ ...base(), createPrivateState: () => ({ emitterSecret: OTHER }) }),
    ).toMatch(/caller is not the emitter authority/);
  });

  it("refuses emitted bytes that differ from the part, and another name", async () => {
    const binding = base();
    expect(
      await buildWith({
        ...binding,
        emitPart: (context, payload) =>
          binding.emitPart(
            context,
            payload.map((b, i) => (i === 60 ? b ^ 1 : b)),
          ),
      }),
    ).toMatch(/execution: part 1: emitted bytes differ from the part/);
    expect(
      await rejects(() =>
        buildPackageTransaction(
          chain.source(),
          configFor(),
          requestFor(emitter, binding, parts, "example:other[v1]"),
        ),
      ),
    ).toMatch(/execution: part 1: emitted bytes differ from the part \(name or payload\)/);
  });

  it("refuses two executions per part and executions without a trace", async () => {
    const binding = base();
    expect(
      await buildWith({
        ...binding,
        emitPart: async (context, payload) => {
          const first = await binding.emitPart(context, payload);
          return binding.emitPart(first.context, payload);
        },
      }),
    ).toMatch(/execution: part 1: (produced 2 call traces|emitted 2 events)/);
    expect(
      await buildWith({
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
      await buildWith({
        ...binding,
        createPrivateState: () => ({ emitterSecret: OTHER }),
        emitPart: (_context, payload) =>
          binding.emitPart(
            createCircuitContext(
              "emitPart",
              foreignEmitter,
              COIN_PUBLIC_KEY,
              RuntimeContractState.deserialize(foreignState.serialize()),
              { emitterSecret: OTHER },
            ),
            payload,
          ),
      }),
    ).toMatch(/trace targets another contract/);
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

describe("package-intent checks (one case per rule)", () => {
  it("accepts the assembled transaction and a faithful re-assembly", () => {
    expect(check(built.transaction, expected, built.frozenTranscripts[0])).toBe("accepted");
    expect(check(at(), expected, built.frozenTranscripts[0])).toBe("accepted");
  });

  it.each([
    ["no parts expected", () => check(at(), { ...expected, parts: [] }), /at least one part/],
    ["segment 0", () => check(at(), { ...expected, segment: 0 }), /not in 1\.\.65535/],
    [
      "no intent at the segment",
      () => check(at(), { ...expected, segment: (expected.segment % 65000) + 1 }),
      /no intent at package segment/,
    ],
    [
      "a missing part",
      () => check(at(expected.segment, specs([0, 1]))),
      /has 2 actions, expected 3/,
    ],
    [
      "an extra part",
      () => check(at(expected.segment, specs([0, 1, 2, 2]))),
      /has 4 actions, expected 3/,
    ],
    [
      "another contract",
      () => check(at(), { ...expected, contract: foreignEmitter }),
      /targets another contract/,
    ],
    [
      "another entry point",
      () => check(at(), { ...expected, entryPoint: "other" }),
      /uses another entry point/,
    ],
    [
      "another name",
      () => check(at(), { ...expected, name: eventName("example:other[v1]") }),
      /call 1 emits bytes other than part 1/,
    ],
    [
      "a demoted (fallible) part",
      () =>
        check(
          at(expected.segment, [
            ...specs([0, 1]),
            ...specs([2], () => ({ guaranteed: undefined, fallible: transcripts[2] })),
          ]),
        ),
      /call 3 has a fallible transcript/,
    ],
    [
      "parts in another order",
      () => check(at(), { ...expected, parts: [...expected.parts].reverse() }),
      /call 1 emits bytes other than part 1/,
    ],
    [
      "a changed transcript (gas)",
      () =>
        check(
          at(
            expected.segment,
            specs([0, 1, 2], (p) =>
              p === 0 ? { guaranteed: starve(transcripts[0] as Transcript) } : {},
            ),
          ),
          expected,
          built.frozenTranscripts[0],
        ),
      /call 1 guaranteed transcript changed/,
    ],
    [
      "a transcript without a log",
      () =>
        check(
          at(
            expected.segment,
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
      /call 2 logs 0 events, expected 1/,
    ],
    [
      "a non-Misc event",
      () =>
        check(
          at(
            expected.segment,
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

  it("refuses a non-call action in the package intent", () => {
    const intent = assembleIntent(chain, emitter, expected.segment, specs([0, 1])).intents?.get(
      expected.segment,
    );
    const state = chain.state.index(emitter);
    if (intent === undefined || state === undefined) throw new Error("setup");
    const replaced = ledger.Transaction.fromParts(NETWORK).addIntent(
      { tag: "specific", value: expected.segment },
      intent.addDeploy(new ledger.ContractDeploy(state)),
    );
    expect(check(replaced)).toMatch(/call 3 is not a contract call/);
    expect(check(withIntent(() => undefined))).toBe("accepted");
  });

  it("refuses a fallible Zswap offer in the package segment", () => {
    const output = ledger.ZswapOutput.new(
      ledger.createShieldedCoinInfo(ledger.sampleRawTokenType(), 1n),
      expected.segment,
      ledger.sampleCoinPublicKey(),
      ledger.sampleEncryptionPublicKey(),
    );
    const offer = ledger.ZswapOffer.fromOutput(output, ledger.sampleRawTokenType(), 1n);
    const tx = at().addZswapOffer({ tag: "specific", value: expected.segment }, offer);
    expect(tx.fallibleOffer?.get(expected.segment)).toBeDefined();
    expect(check(tx)).toMatch(/fallible Zswap offer/);
  });

  it("ignores other intents, including other intents that call the same contract and circuit", async () => {
    const lower = expected.segment > 1 ? expected.segment - 1 : expected.segment + 2;
    const higher = expected.segment < 65535 ? expected.segment + 1 : expected.segment - 2;
    const sameContract = await intentAt(
      chain,
      emitter,
      emitterBinding(SECRET),
      lower,
      patternParts(2, 40),
    );
    const otherContract = await intentAt(
      chain,
      foreignEmitter,
      emitterBinding(OTHER),
      higher,
      patternParts(1, 41),
    );
    const merged = built.transaction.merge(sameContract).merge(otherContract);
    expect(merged.intents?.size).toBe(3);
    expect(check(merged, expected, built.frozenTranscripts[0])).toBe("accepted");
  });

  it("refuses two packages put into one intent, and one package split over two intents", () => {
    const split = at(expected.segment, specs([0, 1])).merge(
      assembleIntent(chain, emitter, (expected.segment % 65000) + 1, specs([2])),
    );
    expect(threw(() => assertTransactionPackages(split, [expected], "test"))).toMatch(
      /has 2 actions, expected 3/,
    );
    const second: ExpectedPackage = { ...expected, parts: [parts[0] as Uint8Array] };
    const oneIntent = at(expected.segment, specs([0, 1, 2, 0]));
    expect(threw(() => assertTransactionPackages(oneIntent, [expected, second], "test"))).toMatch(
      /packages share segment/,
    );
    expect(threw(() => assertTransactionPackages(oneIntent, [expected], "test"))).toMatch(
      /has 4 actions, expected 3/,
    );
  });
});

describe("several packages in one transaction, one intent each", () => {
  it("builds one intent per package (same contract, and another contract), each checked on its own", async () => {
    const multi = await buildPackagesTransaction(chain.source(), configFor(), [
      requestFor(emitter, emitterBinding(SECRET), patternParts(2, 50)),
      requestFor(emitter, emitterBinding(SECRET), patternParts(3, 51)),
      requestFor(foreignEmitter, emitterBinding(OTHER), patternParts(1, 52)),
    ]);
    expect(multi.packages.map((pkg) => pkg.parts.length)).toEqual([2, 3, 1]);
    expect(new Set(multi.packages.map((pkg) => pkg.segment)).size).toBe(3);
    expect(multi.transaction.intents?.size).toBe(3);
    expect(
      multi.packages.map((pkg) => multi.transaction.intents?.get(pkg.segment)?.actions.length),
    ).toEqual([2, 3, 1]);
    expect(multi.frozenTranscripts.map((list) => list.length)).toEqual([2, 3, 1]);
    // A two-state read: one block, one state per distinct contract.
    expect(chain.stateCalls.slice(-2).map((call) => call.address)).toEqual([
      emitter,
      foreignEmitter,
    ]);
  });

  it("refuses the whole transaction before any proof when one package's execution fails", async () => {
    expect(
      await rejects(() =>
        buildPackagesTransaction(chain.source(), configFor(), [
          requestFor(emitter, emitterBinding(SECRET), patternParts(1, 53)),
          requestFor(emitter, emitterBinding(OTHER), patternParts(1, 54)),
        ]),
      ),
    ).toMatch(/caller is not the emitter authority/);
  });
});

describe("finalize with stand-in providers", () => {
  const counters = () => ({ prove: 0, balance: 0, ttl: [] as (Date | undefined)[] });

  const finalizeWith = (
    proveResult: () => ledger.UnprovenTransaction,
    balanceResult?: (tx: ledger.UnprovenTransaction) => ledger.UnprovenTransaction,
    options: Parameters<typeof finalizeTransactionPackages>[2] = offline,
    target: BuiltTransaction = built,
  ) => {
    const count = counters();
    const promise = finalizeTransactionPackages(
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
      target,
      options,
    );
    return { promise, count };
  };

  it("pass-through providers: one proof call, one balance call with the build TTL, a public record", async () => {
    const { promise, count } = finalizeWith(() => built.transaction);
    const record = await promise;
    expect(count).toEqual({ prove: 1, balance: 1, ttl: [built.ttl] });
    expect(record.packages).toHaveLength(1);
    expect(record.packages[0]?.segment).toBe(expected.segment);
    expect(record.packages[0]?.nameHex).toBe(toHex(eventName(EXAMPLE_NAME)));
    expect(record.packages[0]?.partsHex).toEqual(parts.map(toHex));
    expect(record.packages[0]?.intentHash).toMatch(/^[0-9a-f]+$/);
    expect(record.identifiers.length).toBeGreaterThan(0);
    expect(record.transactionHash).toBeNull(); // unproven stand-in: the ledger has no hash for it
    expect(record.ttl).toBe(built.ttl.toISOString());
    expect(JSON.parse(JSON.stringify(record))).toEqual(record);
  });

  it("records every package of a multi-package transaction with its own intent hash", async () => {
    const multi = await buildPackagesTransaction(chain.source(), configFor(), [
      requestFor(emitter, emitterBinding(SECRET), patternParts(2, 60)),
      requestFor(emitter, emitterBinding(SECRET), patternParts(1, 61)),
    ]);
    const { promise } = finalizeWith(() => multi.transaction, undefined, offline, multi);
    const record = await promise;
    expect(record.packages.map((pkg) => pkg.segment)).toEqual(
      multi.packages.map((pkg) => pkg.segment),
    );
    expect(new Set(record.packages.map((pkg) => pkg.intentHash)).size).toBe(2);
  });

  it.each([
    [
      "rewrites one event",
      () =>
        at(
          expected.segment,
          specs([0, 1, 2], (p) =>
            p === 1 ? { guaranteed: retype(transcripts[1] as Transcript) } : {},
          ),
        ),
    ],
    [
      "demotes a part to fallible",
      () =>
        at(expected.segment, [
          ...specs([0, 1]),
          ...specs([2], () => ({ guaranteed: undefined, fallible: transcripts[2] })),
        ]),
    ],
    ["drops a part", () => at(expected.segment, specs([0, 1]))],
    ["adds a part", () => at(expected.segment, specs([0, 1, 2, 0]))],
    ["reorders parts", () => at(expected.segment, specs([1, 0, 2]))],
    [
      "changes a transcript's budget",
      () =>
        at(
          expected.segment,
          specs([0, 1, 2], (p) =>
            p === 2 ? { guaranteed: starve(transcripts[2] as Transcript) } : {},
          ),
        ),
    ],
    ["moves the package to another segment", () => at((expected.segment % 65000) + 1)],
  ])("a prover that %s is refused after proving; the wallet is never asked", async (_, mutate) => {
    const { promise, count } = finalizeWith(mutate);
    expect(await rejects(() => promise)).toMatch(/^after proving: /);
    expect(count.balance).toBe(0);
  });

  it("a prover returning a consistent substitute package is refused", async () => {
    const substitute = await build(SECRET, emitter, 3, 12);
    const { promise } = finalizeWith(() => substitute.transaction);
    expect(await rejects(() => promise)).toMatch(/^after proving: /);
  });

  it("a wallet that changes the package is refused after balancing; honest merges pass, even of the same contract", async () => {
    const demoted = finalizeWith(
      () => built.transaction,
      () =>
        at(expected.segment, [
          ...specs([0, 1]),
          ...specs([2], () => ({ guaranteed: undefined, fallible: transcripts[2] })),
        ]),
    );
    expect(await rejects(() => demoted.promise)).toMatch(
      /^after balancing: call 3 has a fallible transcript/,
    );

    const foreign = await build(OTHER, foreignEmitter, 1, 20);
    const sameContract = await build(SECRET, emitter, 1, 21);
    for (const other of [foreign, sameContract]) {
      if (other.packages[0]?.segment === expected.segment) continue;
      const merged = finalizeWith(
        () => built.transaction,
        (tx) => tx.merge(other.transaction),
      );
      const record = await merged.promise;
      expect(record.packages[0]?.segment).toBe(expected.segment);
    }
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
  let record: FinalizedRecord;
  beforeAll(async () => {
    record = await finalizeTransactionPackages(
      { prover: passThrough, balancer: binder },
      built,
      offline,
    );
  });

  const submitWith = async (changed: FinalizedRecord, options = { requireProofs: false }) => {
    const submitted: ledger.FinalizedTransaction[] = [];
    const message = await rejects(() =>
      submitRecord(
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

  const firstPackage = (r: FinalizedRecord) => {
    const [pkg] = r.packages;
    if (pkg === undefined) throw new Error("no package");
    return pkg;
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
      (r: FinalizedRecord) => {
        // Every copy of these part bytes (event cell and proof input) is changed.
        const needle = (firstPackage(r).partsHex[1] ?? "").slice(40, 80);
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
      (r: FinalizedRecord) => ({ ...r, transactionHash: "00".repeat(32) }),
      /recorded transaction hash/,
    ],
    [
      "a missing identifier",
      (r: FinalizedRecord) => ({ ...r, identifiers: r.identifiers.slice(1) }),
      /recorded identifiers/,
    ],
    [
      "a different intent hash",
      (r: FinalizedRecord) => ({
        ...r,
        packages: [{ ...firstPackage(r), intentHash: "00".repeat(32) }],
      }),
      /recorded intent hash/,
    ],
    [
      "different expected parts",
      (r: FinalizedRecord) => ({
        ...r,
        packages: [{ ...firstPackage(r), partsHex: [...firstPackage(r).partsHex].reverse() }],
      }),
      /before submission: call 1 emits bytes other than part 1/,
    ],
    [
      "another segment",
      (r: FinalizedRecord) => ({
        ...r,
        packages: [{ ...firstPackage(r), segment: (firstPackage(r).segment % 65000) + 1 }],
      }),
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
    const error = new PackageCheckError("after proving", "detail");
    expect(error.message).toBe("after proving: detail");
    expect(error.stage).toBe("after proving");
  });
});
