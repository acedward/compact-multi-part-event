/**
 * Consumer example (examples/consumer): its own contract with application state,
 * `MultiSegmentEmit` + `MessageRegistry` (several owners, register1/2/3/5), its own
 * generated binding and committed keys, simulated, batched through the public
 * composer, applied to a local ledger and verified with the public reader; plus the CLI
 * path for it (deploy-consumer, register, publish --kind consumer, verify).
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ContractState as RuntimeContractState,
  createConstructorContext,
} from "@midnight-ntwrk/compact-runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseSha256Sums } from "../src/adapters/zk-config.js";
import { createWitnessSecretFile, readWitnessSecret } from "../src/adapters/secrets.js";
import { encodePublication, eventValueFor } from "../src/codec/index.js";
import {
  runDeploy,
  runPublish,
  runRegister,
  type DeploymentRecord,
  type PublicationOutcome,
  type RegistrationRecord,
} from "../src/cli/commands.js";
import {
  committedVerifierKeys,
  contractProfiles,
  loadGeneratedModule,
  provableCircuits,
} from "../src/cli/contracts.js";
import { main } from "../src/cli/main.js";
import {
  emitterAuthorityOf,
  messageOwnerOf,
  type MessageOwnerPrivateState,
} from "../src/contract/index.js";
import { board, readBoard } from "../examples/consumer/src/board.js";
import { notice, runOfflineDemo, type DemoReport } from "../examples/consumer/src/offline-demo.js";
import { filled32, patternMessage, toHex } from "./helpers/bytes.js";
import { FakeIndexer } from "./helpers/fake-indexer.js";
import {
  COIN_PUBLIC_KEY,
  context,
  contractInfo,
  emitterContract,
  emitterInitialState,
  miscBytes,
} from "./helpers/generated.js";
import { LocalChain, NETWORK } from "./helpers/ledger.js";
import { offlineServices } from "./helpers/offline-services.js";

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

describe("compiled consumer contract", () => {
  it("has its own application state, the registry, and seven provable circuits", () => {
    const info = contractInfo("examples/consumer/managed/consumer");
    expect(info["compiler-version"]).toBe("0.34.0");
    expect(info["runtime-version"]).toBe("0.19.0");
    const provable = info.circuits
      .filter((circuit) => circuit.proof)
      .map((circuit) => circuit.name);
    expect(provable.sort()).toEqual([
      "announce",
      "emitPart",
      "register1",
      "register2",
      "register3",
      "register5",
      "release",
    ]);
    expect(info.circuits.find((circuit) => circuit.name === "messageOwnerOf")?.pure).toBe(true);
    expect(info.witnesses.map((witness) => witness.name)).toEqual(["messageOwnerSecret"]);
    expect(info.ledger.map((field) => field.name).sort()).toEqual([
      "announcements",
      "latestAnnouncement",
      "messageOwner",
    ]);
  });

  it("commits a verifier key per provable circuit, each listed with its hash", () => {
    const profile = contractProfiles().consumer;
    const keys = committedVerifierKeys(profile);
    expect(Object.keys(keys).sort()).toEqual(provableCircuits(profile));
    const sums = parseSha256Sums(readFileSync("examples/consumer/keys/SHA256SUMS", "utf8"));
    expect(sums.size).toBe(28);
    for (const [circuit, key] of Object.entries(keys)) {
      expect(sums.get(`keys/${circuit}.verifier`)).toBe(sha(key));
    }
    expect(sha(keys.emitPart ?? new Uint8Array())).not.toBe(
      "a14b8e2d443e2f2b60b24326097cdad929333ee998f00e503d30e8e01a0ca6f2",
    );
  });

  it("emits exactly the reference emitter's bytes for the same request id and tail", async () => {
    const owner = filled32(0x41);
    const publication = encodePublication(patternMessage(300));
    const part = publication.parts[1];
    if (part === undefined) throw new Error("no part");
    const consumer = board();
    const initial = await consumer.initialState(
      createConstructorContext<MessageOwnerPrivateState>(
        { messageOwnerSecret: owner },
        COIN_PUBLIC_KEY,
      ),
    );
    const address = "0a".repeat(32);
    const registered = await consumer.impureCircuits.register2(
      context("register2", address, initial.currentContractState, { messageOwnerSecret: owner }),
      publication.requestId,
      publication.parts.map((entry) => entry.tail),
    );
    const state = registered.context.callContext.currentQueryContext.state;
    const emitted = await consumer.impureCircuits.emitPart(
      context("emitPart", address, state, { messageOwnerSecret: owner }),
      publication.requestId,
      part.tail,
    );
    const [event] = emitted.context.events;
    if (event === undefined) throw new Error("no event");
    expect(miscBytes(event)).toEqual(eventValueFor(publication.requestId, part.tail));

    const reference = emitterContract();
    const secret = filled32(0x42);
    const referenceEmitted = await reference.impureCircuits.emitPart(
      context("emitPart", address, await emitterInitialState(emitterAuthorityOf(secret)), {
        emitterSecret: secret,
      }),
      publication.requestId,
      part.tail,
    );
    const [referenceEvent] = referenceEmitted.context.events;
    if (referenceEvent === undefined) throw new Error("no reference event");
    expect(miscBytes(referenceEvent)).toEqual(miscBytes(event));
  });
});

describe("offline demo (public entry points only)", () => {
  let report: DemoReport;
  beforeAll(async () => {
    report = await runOfflineDemo();
  });

  it("publishes two owners' notices, each rebuilt from events and from the raw transaction", () => {
    expect(report.publications).toHaveLength(2);
    expect(report.publications.map((entry) => [entry.owner, entry.parts, entry.bytes])).toEqual([
      ["alice", 3, 417],
      ["bob", 5, 1000],
    ]);
    for (const entry of report.publications) {
      expect(entry.fromEvents).toBe("Complete, message equal");
      expect(entry.fromRawTransaction).toBe("accepted, guaranteed-only placement");
      expect(entry.stateUnchangedByPublication).toBe(true);
    }
    expect(report.publications[0]?.requestId).toBe(
      toHex(encodePublication(notice(417, 7)).requestId),
    );
  });

  it("refuses front-running, foreign emission and foreign release at execution", () => {
    expect(report.refusals).toHaveLength(3);
    expect(report.refusals[0]).toMatch(/bob registers alice's notice: .*already registered/);
    expect(report.refusals[1]).toMatch(
      /bob emits parts of alice's notice: .*does not own this request id/,
    );
    expect(report.refusals[2]).toMatch(
      /bob releases alice's notice: .*does not own this request id/,
    );
  });

  it("keeps the application state: one announcement, the latest id, and the released entry gone", () => {
    expect(report.announcements).toBe(1n);
    expect(report.latestAnnouncement).toBe(report.publications[0]?.requestId);
    expect(report.releasedStillRegistered).toBe(false);
  });
});

describe("CLI path for the consumer", () => {
  const profile = contractProfiles().consumer;
  const dir = mkdtempSync(join(tmpdir(), "cmse-consumer-"));
  const ownerFile = join(dir, "owner.secret");
  const MESSAGE = patternMessage(624, 5);
  let chain: LocalChain;
  let fake: FakeIndexer;
  let deployment: DeploymentRecord;
  let registration: RegistrationRecord;
  let publication: PublicationOutcome;
  let served: { indexerUrl: string; nodeUrl: string; close(): Promise<void> };

  beforeAll(async () => {
    const generated = await loadGeneratedModule(profile);
    chain = new LocalChain();
    fake = new FakeIndexer(chain);
    deployment = await runDeploy(offlineServices(fake).services, {
      profile,
      generated,
      verifierKeys: committedVerifierKeys(profile),
      maintenanceKeyFile: join(dir, "maintenance.json"),
      ttlSeconds: 1200,
    });
    registration = await runRegister(offlineServices(fake).services, {
      profile,
      generated,
      address: deployment.address,
      message: MESSAGE,
      ownerSecretFile: ownerFile,
      createOwnerSecret: true,
      ttlSeconds: 1200,
      circuits: provableCircuits(profile),
      out: join(dir, "registration.json"),
    });
    publication = await runPublish(offlineServices(fake).services, {
      profile,
      generated,
      address: deployment.address,
      message: MESSAGE,
      secretFile: ownerFile,
      maxParts: 8,
      ttlSeconds: 1200,
    });
    served = await fake.serve();
  });

  afterAll(async () => {
    await served.close();
  });

  it("deploys the board with its seven committed keys and no whitelist authority", () => {
    expect(deployment.stage).toBe("verified");
    expect(deployment.operations).toHaveLength(7);
    expect(deployment.emitterAuthority).toBeUndefined();
  });

  it("registers in its own transaction before the publication; the record holds only the commitment", () => {
    expect(registration.circuit).toBe("register3");
    expect(registration.parts).toBe(3);
    expect(registration.ownerCommitment).toBe(toHex(messageOwnerOf(readWitnessSecret(ownerFile))));
    const saved = readFileSync(join(dir, "registration.json"), "utf8");
    expect(saved).not.toContain(toHex(readWitnessSecret(ownerFile)));
    expect(registration.inclusion?.blockHeight).toBeLessThan(
      publication.inclusion?.blockHeight ?? 0,
    );
  });

  it("publishes through the composer with the board's binding and verifies at levels 1-3", async () => {
    expect(publication.verified).toBe(true);
    const lines: string[] = [];
    const status = await main(
      [
        "verify",
        "--kind",
        "consumer",
        "--network",
        NETWORK,
        "--indexer",
        served.indexerUrl,
        "--contract",
        deployment.address,
        "--tx",
        publication.inclusion?.hash ?? "",
      ],
      {},
      { out: (line) => lines.push(line), err: (line) => lines.push(line) },
    );
    expect(lines.join("\n")).toContain("verified up to level 3");
    expect(status).toBe(0);
  });

  it("refuses a message size the board has no register circuit for", async () => {
    const generated = await loadGeneratedModule(profile);
    const other = join(dir, "other.secret");
    createWitnessSecretFile(other);
    await expect(
      runRegister(offlineServices(fake).services, {
        profile,
        generated,
        address: deployment.address,
        message: patternMessage(208 * 7),
        ownerSecretFile: other,
        ttlSeconds: 1200,
        circuits: provableCircuits(profile),
      }),
    ).rejects.toThrow(
      /7 parts, but the contract exports no register7 \(it has register1, register2, register3, register5\)/,
    );
  });

  it("the application state is readable through the board's own binding", () => {
    const state = RuntimeContractState.deserialize(
      chain.state.index(deployment.address)?.serialize() ?? new Uint8Array(),
    );
    const view = readBoard(state.data);
    expect(view.announcements).toBe(0n);
    expect(view.ownerOf(encodePublication(MESSAGE).requestId)).toEqual(
      messageOwnerOf(readWitnessSecret(ownerFile)),
    );
  });
});
