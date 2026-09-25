/**
 * Compiled Compact examples in the runtime 0.19.0 simulator: circuit surfaces and
 * purity, the exact emitted event of each adopter, the whitelist, and the test-only
 * open emitter.
 */
import { createConstructorContext } from "@midnight-ntwrk/compact-runtime";
import { describe, expect, it } from "vitest";

import { emitterAuthorityOf } from "../contract-examples/whitelist/whitelist.js";
import { eventName } from "../src/reader/index.js";
import { ascii, filled32, patternParts, sha256 } from "./helpers/bytes.js";
import {
  COIN_PUBLIC_KEY,
  context,
  contractInfo,
  emitterContract,
  emitterInitialState,
  emitterModule,
  EXAMPLE_NAME,
  miscBytes,
  NOTICE_NAME,
  noticeBoardModule,
  openEmitterContract,
  openEmitterInitialState,
  sampleAddress,
} from "./helpers/generated.js";

const EMITTER_SECRET = filled32(0x11);
const OTHER_SECRET = filled32(0x22);

const opNames = (program: readonly unknown[]): string[] =>
  program.map((op) => (typeof op === "string" ? op : (Object.keys(op as object)[0] ?? "?")));

const surface = (managed: string) => {
  const info = contractInfo(managed);
  return {
    compiler: info["compiler-version"],
    runtime: info["runtime-version"],
    circuits: info.circuits.map(({ name, pure, proof }) => ({ name, pure, proof })),
    witnesses: info.witnesses.map(({ name }) => name),
    ledger: info.ledger.map(({ name, storage }) => ({ name, storage })),
  };
};

describe("compiled surfaces", () => {
  it("reference emitter: emitPart impure and provable, emitterAuthorityOf pure, one sealed cell", () => {
    expect(surface("contract-examples/emitter/managed")).toEqual({
      compiler: "0.34.0",
      runtime: "0.19.0",
      circuits: [
        { name: "emitterAuthorityOf", pure: true, proof: false },
        { name: "emitPart", pure: false, proof: true },
      ],
      witnesses: ["emitterSecret"],
      ledger: [{ name: "emitterAuthority", storage: "Cell" }],
    });
    expect(Object.keys(emitterContract().impureCircuits)).toEqual(["emitPart"]);
    expect(Object.keys(emitterModule.pureCircuits)).toEqual(["emitterAuthorityOf"]);
  });

  it("notice board: its own state, emitPart and pin impure and provable", () => {
    expect(surface("contract-examples/notice-board/managed")).toEqual({
      compiler: "0.34.0",
      runtime: "0.19.0",
      circuits: [
        { name: "emitterAuthorityOf", pure: true, proof: false },
        { name: "emitPart", pure: false, proof: true },
        { name: "pin", pure: false, proof: true },
      ],
      witnesses: ["emitterSecret"],
      ledger: [
        { name: "emitterAuthority", storage: "Cell" },
        { name: "pinnedCount", storage: "Counter" },
        { name: "pinnedDigest", storage: "Cell" },
      ],
    });
  });

  it("open emitter (test only): emitPart without witnesses or state", () => {
    expect(surface("tests/contracts/managed/open-emitter")).toEqual({
      compiler: "0.34.0",
      runtime: "0.19.0",
      circuits: [{ name: "emitPart", pure: false, proof: true }],
      witnesses: [],
      ledger: [],
    });
  });
});

describe("EmitterWhitelist", () => {
  it("the off-chain commitment equals both contracts' pure emitterAuthorityOf", () => {
    for (const secret of [EMITTER_SECRET, OTHER_SECRET, new Uint8Array(32), sha256(ascii("x"))]) {
      expect(emitterAuthorityOf(secret)).toEqual(
        emitterModule.pureCircuits.emitterAuthorityOf(secret),
      );
      expect(emitterAuthorityOf(secret)).toEqual(
        noticeBoardModule.pureCircuits.emitterAuthorityOf(secret),
      );
    }
    expect(() => emitterAuthorityOf(new Uint8Array(31))).toThrow(/32 bytes/);
  });

  it("the constructor refuses a zero authority and stores a non-zero one (sealed)", async () => {
    await expect(emitterInitialState(new Uint8Array(32))).rejects.toThrow(
      /EmitterWhitelist: zero authority/,
    );
    const authority = emitterAuthorityOf(EMITTER_SECRET);
    const state = await emitterInitialState(authority);
    expect(emitterModule.ledger(state.data).emitterAuthority).toEqual(authority);
  });

  it("a caller with the wrong or a missing secret fails during execution: no event, no proof input", async () => {
    const state = await emitterInitialState(emitterAuthorityOf(EMITTER_SECRET));
    const address = sampleAddress();
    const [part] = patternParts(1);
    if (part === undefined) throw new Error("no part");
    const contract = emitterContract();
    await expect(
      contract.circuits.emitPart(
        context("emitPart", address, state, { emitterSecret: OTHER_SECRET }),
        part,
      ),
    ).rejects.toThrow(/EmitterWhitelist: caller is not the emitter authority/);
    await expect(
      contract.circuits.emitPart(
        context("emitPart", address, state, { emitterSecret: new Uint8Array(0) }),
        part,
      ),
    ).rejects.toThrow(/secret must be 32 bytes/);
  });
});

describe("emitted events", () => {
  it("reference emitter: each part emits exactly one Misc event, name example:message[v1], the payload unchanged; no state change", async () => {
    const state = await emitterInitialState(emitterAuthorityOf(EMITTER_SECRET));
    const address = sampleAddress();
    const parts = patternParts(3, 1);
    const contract = emitterContract();
    // Every part runs from the same pre-state, as the publisher does.
    const results = await Promise.all(
      parts.map((part) =>
        contract.circuits.emitPart(
          context("emitPart", address, state, { emitterSecret: EMITTER_SECRET }),
          part,
        ),
      ),
    );
    results.forEach((result, index) => {
      expect(result.context.events).toHaveLength(1);
      const [event] = result.context.events;
      if (event === undefined) throw new Error("no event");
      expect(event.address).toBe(address);
      expect(event.version).toBe(1);
      const bytes = miscBytes(event);
      expect(bytes.subarray(0, 32)).toEqual(eventName(EXAMPLE_NAME));
      expect(bytes.subarray(0, 19)).toEqual(ascii("example:message[v1]"));
      expect(bytes.subarray(19, 32)).toEqual(new Uint8Array(13));
      expect(bytes.subarray(32)).toEqual(parts[index]);
      const traces = result.context.callProofDataTrace;
      expect(traces).toHaveLength(1);
      // One read of the sealed authority cell, then the event.
      expect(opNames(traces[0]?.publicTranscript ?? [])).toEqual([
        "dup",
        "idx",
        "popeq",
        "push",
        "log",
      ]);
      expect(result.context.callContext.currentQueryContext.state.state.encode()).toEqual(
        state.data.state.encode(),
      );
    });
  });

  it("notice board: emitPart emits notice-board:notice[v1] and leaves the board's state unchanged; pin changes it", async () => {
    type Board = { emitterSecret: Uint8Array };
    const contract = new noticeBoardModule.Contract<Board>({
      emitterSecret: ({ privateState }) => [privateState, privateState.emitterSecret],
    });
    const initial = await contract.initialState(
      createConstructorContext<Board>({ emitterSecret: EMITTER_SECRET }, COIN_PUBLIC_KEY),
      emitterAuthorityOf(EMITTER_SECRET),
    );
    const state = initial.currentContractState;
    const address = sampleAddress();
    const [part] = patternParts(1, 4);
    if (part === undefined) throw new Error("no part");
    const emitted = await contract.circuits.emitPart(
      context("emitPart", address, state, { emitterSecret: EMITTER_SECRET }),
      part,
    );
    const [event] = emitted.context.events;
    if (event === undefined) throw new Error("no event");
    expect(miscBytes(event).subarray(0, 32)).toEqual(eventName(NOTICE_NAME));
    expect(miscBytes(event).subarray(32)).toEqual(part);
    expect(emitted.context.callContext.currentQueryContext.state.state.encode()).toEqual(
      state.data.state.encode(),
    );
    const digest = sha256(part);
    const pinned = await contract.circuits.pin(
      context("pin", address, state, { emitterSecret: EMITTER_SECRET }),
      digest,
    );
    expect(pinned.context.events).toHaveLength(0);
    const after = noticeBoardModule.ledger(pinned.context.callContext.currentQueryContext.state);
    expect(after.pinnedCount).toBe(1n);
    expect(after.pinnedDigest).toEqual(digest);
    await expect(
      contract.circuits.pin(
        context("pin", address, state, { emitterSecret: OTHER_SECRET }),
        digest,
      ),
    ).rejects.toThrow(/caller is not the emitter authority/);
  });

  it("open emitter: anyone emits example:message[v1] with the payload unchanged", async () => {
    const state = await openEmitterInitialState();
    const address = sampleAddress();
    const [part] = patternParts(1, 9);
    if (part === undefined) throw new Error("no part");
    const result = await openEmitterContract().circuits.emitPart(
      context("emitPart", address, state, undefined),
      part,
    );
    const [event] = result.context.events;
    if (event === undefined) throw new Error("no event");
    const bytes = miscBytes(event);
    expect(bytes.subarray(0, 32)).toEqual(eventName(EXAMPLE_NAME));
    expect(bytes.subarray(32)).toEqual(part);
    expect(opNames(result.context.callProofDataTrace[0]?.publicTranscript ?? [])).toEqual([
      "push",
      "log",
    ]);
    expect(eventName(NOTICE_NAME)).not.toEqual(eventName(EXAMPLE_NAME));
  });
});
