/**
 * Compiled Compact behaviour in the runtime 0.19.0 simulator: circuit surface and
 * purity, the exact emitted event, and both example access controls.
 */
import type { ChargedState, ContractState } from "@midnight-ntwrk/compact-runtime";
import { describe, expect, it } from "vitest";

import {
  emitterAuthorityOf,
  type MessageOwnerPrivateState,
  messageOwnerOf,
} from "../src/contract/index.js";
import { ascii, filled32, patternMessage, sha256, specName, specTails } from "./helpers/bytes.js";
import {
  context,
  contractInfo,
  emitterBinding,
  emitterContract,
  emitterInitialState,
  miscBytes,
  registryBinding,
  registryContract,
  registryInitialState,
  sampleAddress,
} from "./helpers/generated.js";

const EMITTER_SECRET = filled32(0x11);
const OTHER_SECRET = filled32(0x22);

const opNames = (program: readonly unknown[]): string[] =>
  program.map((op) => (typeof op === "string" ? op : (Object.keys(op as object)[0] ?? "?")));

describe("compiled surface", () => {
  it("reference emitter: emitPart is impure and provable; emitterAuthorityOf is pure; nothing else", () => {
    const info = contractInfo("contracts/managed/emitter");
    expect(info["compiler-version"]).toBe("0.34.0");
    expect(info["runtime-version"]).toBe("0.19.0");
    expect(info.circuits.map(({ name, pure, proof }) => ({ name, pure, proof }))).toEqual([
      { name: "emitterAuthorityOf", pure: true, proof: false },
      { name: "emitPart", pure: false, proof: true },
    ]);
    expect(info.witnesses.map(({ name }) => name)).toEqual(["emitterSecret"]);
    expect(info.ledger.map(({ name, storage, exported }) => ({ name, storage, exported }))).toEqual(
      [{ name: "emitterAuthority", storage: "Cell", exported: true }],
    );
    const contract = emitterContract();
    expect(Object.keys(contract.impureCircuits)).toEqual(["emitPart"]);
    expect(Object.keys(contract.provableCircuits)).toEqual(["emitPart"]);
    expect(Object.keys(emitterBinding.pureCircuits)).toEqual(["emitterAuthorityOf"]);
  });

  it("registry test contract: registration, emission and release are impure and provable", () => {
    const info = contractInfo("tests/contracts/managed/registry-emitter");
    expect(info.circuits.map(({ name, pure, proof }) => ({ name, pure, proof }))).toEqual([
      { name: "messageOwnerOf", pure: true, proof: false },
      { name: "register1", pure: false, proof: true },
      { name: "register2", pure: false, proof: true },
      { name: "register3", pure: false, proof: true },
      { name: "emitPart", pure: false, proof: true },
      { name: "release", pure: false, proof: true },
    ]);
    expect(info.witnesses.map(({ name }) => name)).toEqual(["messageOwnerSecret"]);
    expect(info.ledger.map(({ name, storage }) => ({ name, storage }))).toEqual([
      { name: "messageOwner", storage: "Map" },
    ]);
    expect(Object.keys(registryBinding.pureCircuits)).toEqual(["messageOwnerOf"]);
  });
});

describe("EmitterWhitelist on the reference emitter", () => {
  it("the off-chain commitment equals the contract's pure emitterAuthorityOf", () => {
    for (const secret of [EMITTER_SECRET, OTHER_SECRET, new Uint8Array(32), sha256(ascii("x"))]) {
      expect(emitterAuthorityOf(secret)).toEqual(
        emitterBinding.pureCircuits.emitterAuthorityOf(secret),
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
    expect(emitterBinding.ledger(state.data).emitterAuthority).toEqual(authority);
  });

  it("an authorized part emits exactly the specified Misc event and changes no state", async () => {
    const state = await emitterInitialState(emitterAuthorityOf(EMITTER_SECRET));
    const address = sampleAddress();
    const message = patternMessage(300);
    const tails = specTails(message);
    const requestId = sha256(...tails);
    expect(tails).toHaveLength(2);

    const contract = emitterContract();
    // Both parts run from the same pre-state, as the batch composer does.
    const results = await Promise.all(
      tails.map((tail) =>
        contract.circuits.emitPart(
          context("emitPart", address, state, { emitterSecret: EMITTER_SECRET }),
          requestId,
          tail,
        ),
      ),
    );
    results.forEach((result, index) => {
      const events = result.context.events;
      expect(events).toHaveLength(1);
      const [event] = events;
      if (event === undefined) throw new Error("no event");
      expect(event.address).toBe(address);
      expect(event.version).toBe(1);
      const bytes = miscBytes(event);
      expect(bytes.subarray(0, 32)).toEqual(specName(index + 1, 2));
      expect(bytes.subarray(0, 13)).toEqual(ascii("mip-xxxx[v1]:"));
      expect(bytes.subarray(21, 32)).toEqual(new Uint8Array(11));
      expect(bytes.subarray(32, 64)).toEqual(requestId);
      expect(bytes.subarray(64)).toEqual(tails[index]);

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
      const after = result.context.callContext.currentQueryContext.state;
      expect(after.state.encode()).toEqual(state.data.state.encode());
    });
  });

  it("copies tail bytes 0..7 into the name without validating them (the reader validates)", async () => {
    const state = await emitterInitialState(emitterAuthorityOf(EMITTER_SECRET));
    const address = sampleAddress();
    const tail = new Uint8Array(224);
    tail.set(ascii("junk!!!!"), 0);
    const result = await emitterContract().circuits.emitPart(
      context("emitPart", address, state, { emitterSecret: EMITTER_SECRET }),
      new Uint8Array(32),
      tail,
    );
    const [event] = result.context.events;
    if (event === undefined) throw new Error("no event");
    expect(miscBytes(event).subarray(13, 21)).toEqual(ascii("junk!!!!"));
  });

  it("a caller with the wrong or a missing secret fails during execution: no event, no proof input", async () => {
    const state = await emitterInitialState(emitterAuthorityOf(EMITTER_SECRET));
    const address = sampleAddress();
    const [tail] = specTails(patternMessage(10));
    if (tail === undefined) throw new Error("no tail");
    const contract = emitterContract();
    await expect(
      contract.circuits.emitPart(
        context("emitPart", address, state, { emitterSecret: OTHER_SECRET }),
        new Uint8Array(32),
        tail,
      ),
    ).rejects.toThrow(/EmitterWhitelist: caller is not the emitter authority/);
    await expect(
      contract.circuits.emitPart(
        context("emitPart", address, state, { emitterSecret: new Uint8Array(0) }),
        new Uint8Array(32),
        tail,
      ),
    ).rejects.toThrow(/secret must be 32 bytes/);
  });
});

describe("MessageRegistry on the registry test contract", () => {
  const owner: MessageOwnerPrivateState = { messageOwnerSecret: filled32(0x33) };
  const stranger: MessageOwnerPrivateState = { messageOwnerSecret: filled32(0x44) };
  const message = patternMessage(500, 7);
  const tails = specTails(message);
  const requestId = sha256(...tails);

  const registered = async (): Promise<{ address: string; state: ChargedState }> => {
    const initial: ContractState = await registryInitialState();
    const address = sampleAddress();
    const result = await registryContract().circuits.register3(
      context("register3", address, initial, owner),
      requestId,
      tails,
    );
    return { address, state: result.context.callContext.currentQueryContext.state };
  };

  it("the off-chain owner commitment equals the contract's pure messageOwnerOf", () => {
    expect(messageOwnerOf(owner.messageOwnerSecret)).toEqual(
      registryBinding.pureCircuits.messageOwnerOf(owner.messageOwnerSecret),
    );
  });

  it("registration accepts only tails whose SHA-256 is the request id (N = 1, 2, 3)", async () => {
    expect(tails).toHaveLength(3);
    const { state } = await registered();
    const ledgerState = registryBinding.ledger(state);
    expect(ledgerState.messageOwner.member(requestId)).toBe(true);
    expect(ledgerState.messageOwner.lookup(requestId)).toEqual(
      messageOwnerOf(owner.messageOwnerSecret),
    );

    const contract = registryContract();
    const initial = await registryInitialState();
    const one = specTails(patternMessage(100));
    const two = specTails(patternMessage(300));
    await expect(
      contract.circuits.register1(
        context("register1", sampleAddress(), initial, owner),
        sha256(...one),
        one,
      ),
    ).resolves.toBeDefined();
    await expect(
      contract.circuits.register2(
        context("register2", sampleAddress(), initial, owner),
        sha256(...two),
        two,
      ),
    ).resolves.toBeDefined();
    const wrong = sha256(...tails).map((byte, index) => (index === 0 ? byte ^ 1 : byte));
    await expect(
      contract.circuits.register3(
        context("register3", sampleAddress(), initial, owner),
        wrong,
        tails,
      ),
    ).rejects.toThrow(/request id does not match the tails/);
  });

  it("a request id can be registered only once, even by someone else", async () => {
    const { address, state } = await registered();
    for (const who of [owner, stranger]) {
      await expect(
        registryContract().circuits.register3(
          context("register3", address, state, who),
          requestId,
          tails,
        ),
      ).rejects.toThrow(/request id already registered/);
    }
  });

  it("parts need a registration and the owner's secret; they only read the registry", async () => {
    const contract = registryContract();
    const initial = await registryInitialState();
    await expect(
      contract.circuits.emitPart(
        context("emitPart", sampleAddress(), initial, owner),
        requestId,
        tails[0] ?? new Uint8Array(224),
      ),
    ).rejects.toThrow(/request id not registered/);

    const { address, state } = await registered();
    await expect(
      contract.circuits.emitPart(
        context("emitPart", address, state, stranger),
        requestId,
        tails[0] ?? new Uint8Array(224),
      ),
    ).rejects.toThrow(/caller does not own this request id/);

    const results = await Promise.all(
      tails.map((tail) =>
        contract.circuits.emitPart(context("emitPart", address, state, owner), requestId, tail),
      ),
    );
    results.forEach((result, index) => {
      const [event] = result.context.events;
      if (event === undefined) throw new Error("no event");
      expect(miscBytes(event)).toEqual(
        Uint8Array.from([...specName(index + 1, 3), ...requestId, ...(tails[index] ?? [])]),
      );
      const after = result.context.callContext.currentQueryContext.state;
      expect(after.state.encode()).toEqual(state.state.encode());
    });
  });

  it("only the owner can release; afterwards parts fail and the id can be registered again", async () => {
    const contract = registryContract();
    const { address, state } = await registered();
    await expect(
      contract.circuits.release(context("release", address, state, stranger), requestId),
    ).rejects.toThrow(/caller does not own this request id/);
    const released = await contract.circuits.release(
      context("release", address, state, owner),
      requestId,
    );
    const afterRelease = released.context.callContext.currentQueryContext.state;
    expect(registryBinding.ledger(afterRelease).messageOwner.member(requestId)).toBe(false);
    await expect(
      contract.circuits.emitPart(
        context("emitPart", address, afterRelease, owner),
        requestId,
        tails[0] ?? new Uint8Array(224),
      ),
    ).rejects.toThrow(/request id not registered/);
    await expect(
      contract.circuits.register3(
        context("register3", address, afterRelease, stranger),
        requestId,
        tails,
      ),
    ).resolves.toBeDefined();
  });
});
