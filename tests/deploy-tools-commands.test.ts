/**
 * deploy-tools end to end over the in-process ledger and the fake indexer:
 *
 * - `deploy` (both examples): the emitter secret and maintenance key are created in
 *   protected files and never printed or recorded; the address is recorded before
 *   submission; the explicit `ContractDeploy` installs the committed verifier keys; the
 *   deployed state is checked; existing secrets and records are never overwritten.
 * - `publish`: one message is one package in one intent; several messages go into ONE
 *   transaction, one intent each; the record (finalized bytes, identifiers, segments,
 *   intent hashes) is written before the one submission; inclusion is found by
 *   identifier and every package is verified from the raw bytes; dry runs submit
 *   nothing; a transaction that never appears fails with a named reason.
 * - `pin`: the notice board's state-changing circuit, in a transaction of its own.
 * - `main()`: the whole argument path of `publish`, `deploy` and `pin` with stand-in
 *   wallet and prover; usage errors (exit 2) before any wallet is opened; `--help`
 *   lists every flag and variable; `funding` prints balances only after a complete
 *   sync ("not synced", exit 1, otherwise); sync timeout, cache and fee margin
 *   (default 5, 0..100, flag before variable) reach the wallet.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type * as ledger from "@midnightntwrk/ledger-v9";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { encodeNotice } from "../contract-examples/notice-board/src/board.js";
import {
  CommandFailure,
  type DeploymentRecord,
  type PinRecord,
  type PublicationRecord,
  runDeploy,
  runFunding,
  runPin,
  runPublish,
} from "../deploy-tools/commands.js";
import {
  committedVerifierKeys,
  encodeNoticeText,
  exampleProfiles,
  type GeneratedModule,
  loadGeneratedModule,
} from "../deploy-tools/contracts.js";
import { main, type ToolWallet } from "../deploy-tools/main.js";
import { readWitnessSecret } from "../deploy-tools/secrets.js";
import {
  deriveWalletKeys,
  publicIdentity,
  type WalletBalances,
  type WalletSessionOptions,
} from "../deploy-tools/wallet.js";
import { WalletNotSyncedError } from "../deploy-tools/wallet-sync.js";
import { verifierKeySha256 } from "../src/cli/verifier-key.js";
import { patternMessage, toHex } from "./helpers/bytes.js";
import { FakeIndexer } from "./helpers/fake-indexer.js";
import { LocalChain, NETWORK } from "./helpers/ledger.js";
import { offlineServices, standInBalancer, standInProver } from "./helpers/offline-services.js";

const profiles = exampleProfiles();
const secretsDir = mkdtempSync(join(tmpdir(), "cmse-tools-secrets-"));
const outDir = mkdtempSync(join(tmpdir(), "cmse-tools-out-"));
const emitterSecret = join(secretsDir, "emitter.secret");
const boardSecret = join(secretsDir, "board.secret");
const MESSAGE = patternMessage(417);
const NOTICES = ["Board opens at nine.", "x".repeat(600)];

const EMITTER_EMIT_PART_SHA256 = "b25a6c6a565fde435afeacbae73434a9db2730f871e53da589395a27144842d7";
const BOARD_EMIT_PART_SHA256 = "c229adeae798df1047abd8cd45738f9e26d0975b08d6dd0f07e9662bfcf87aa5";
const BOARD_PIN_SHA256 = "24716b3a1d5e1427e3a334dd51dd0e459986bdf5f754709560b5a633ea78971a";

let emitterModule: GeneratedModule;
let boardModule: GeneratedModule;
let chain: LocalChain;
let fake: FakeIndexer;
let emitter: DeploymentRecord;
let board: DeploymentRecord;
let deployLines: string[];
let single: PublicationRecord;
let several: PublicationRecord;
let publishLines: string[];
let pinned: PinRecord;
let served: { indexerUrl: string; nodeUrl: string; close(): Promise<void> };

const out = (name: string): string => join(outDir, name);

beforeAll(async () => {
  emitterModule = await loadGeneratedModule(profiles.emitter);
  boardModule = await loadGeneratedModule(profiles["notice-board"]);
  chain = new LocalChain();
  fake = new FakeIndexer(chain);
  const deployed = offlineServices(fake);
  emitter = await runDeploy(deployed.services, {
    profile: profiles.emitter,
    generated: emitterModule,
    verifierKeys: committedVerifierKeys(profiles.emitter),
    emitterSecretFile: emitterSecret,
    maintenanceKeyFile: join(secretsDir, "emitter-maintenance.json"),
    ttlSeconds: 1200,
    out: out("deploy-emitter.json"),
  });
  board = await runDeploy(deployed.services, {
    profile: profiles["notice-board"],
    generated: boardModule,
    verifierKeys: committedVerifierKeys(profiles["notice-board"]),
    emitterSecretFile: boardSecret,
    maintenanceKeyFile: join(secretsDir, "board-maintenance.json"),
    ttlSeconds: 1200,
    out: out("deploy-board.json"),
  });
  deployLines = deployed.lines;
  const published = offlineServices(fake);
  single = await runPublish(published.services, {
    profile: profiles.emitter,
    generated: emitterModule,
    address: emitter.address,
    messages: [MESSAGE],
    secretFile: emitterSecret,
    maxParts: 8,
    ttlSeconds: 1200,
    out: out("publish-single.json"),
  });
  several = await runPublish(published.services, {
    profile: profiles["notice-board"],
    generated: boardModule,
    address: board.address,
    messages: NOTICES.map(encodeNoticeText),
    secretFile: boardSecret,
    maxParts: 8,
    ttlSeconds: 1200,
    out: out("publish-several.json"),
  });
  publishLines = published.lines;
  pinned = await runPin(offlineServices(fake).services, {
    profile: profiles["notice-board"],
    generated: boardModule,
    address: board.address,
    digest: Uint8Array.from(
      createHash("sha256")
        .update(NOTICES[1] ?? "")
        .digest(),
    ),
    secretFile: boardSecret,
    ttlSeconds: 1200,
    out: out("pin.json"),
  });
  served = await fake.serve();
});

afterAll(async () => {
  await served.close();
});

const readRecord = <T>(name: string): T => JSON.parse(readFileSync(out(name), "utf8")) as T;

describe("deploy", () => {
  it("creates the secrets in protected files and never prints or records them", () => {
    for (const path of [emitterSecret, boardSecret]) {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    const everything = [
      ...deployLines,
      ...publishLines,
      ...["deploy-emitter.json", "deploy-board.json", "publish-single.json", "pin.json"].map(
        (name) => readFileSync(out(name), "utf8"),
      ),
    ].join("\n");
    for (const path of [emitterSecret, boardSecret]) {
      expect(everything).not.toContain(toHex(readWitnessSecret(path)));
    }
    for (const name of ["emitter-maintenance.json", "board-maintenance.json"]) {
      const key = JSON.parse(readFileSync(join(secretsDir, name), "utf8")) as { value: string };
      expect(everything).not.toContain(key.value);
    }
  });

  it("records the address before submission and ends verified, with the committed keys", () => {
    expect(deployLines[0]).toBe(
      `contract address   ${emitter.address} (recorded before submission)`,
    );
    const emitterRecord = readRecord<DeploymentRecord>("deploy-emitter.json");
    expect(emitterRecord.stage).toBe("verified");
    expect(emitterRecord.eventName).toBe("example:message[v1]");
    expect(emitterRecord.operations).toEqual(["emitPart"]);
    expect(emitterRecord.verifierKeySha256).toEqual({ emitPart: EMITTER_EMIT_PART_SHA256 });
    expect(emitterRecord.inclusion?.status).toBe("SUCCESS");
    const boardRecord = readRecord<DeploymentRecord>("deploy-board.json");
    expect(boardRecord.stage).toBe("verified");
    expect(boardRecord.eventName).toBe("notice-board:notice[v1]");
    expect(boardRecord.verifierKeySha256).toEqual({
      emitPart: BOARD_EMIT_PART_SHA256,
      pin: BOARD_PIN_SHA256,
    });
    expect(chain.state.index(board.address)?.maintenanceAuthority.threshold).toBe(1);
    expect(
      verifierKeySha256(
        chain.state.index(board.address)?.operation("pin")?.verifierKey ?? new Uint8Array(),
      ),
    ).toBe(BOARD_PIN_SHA256);
  });

  it("refuses to overwrite an existing secret or record before building anything", async () => {
    const { services, submitted } = offlineServices(fake);
    const base = {
      profile: profiles.emitter,
      generated: emitterModule,
      verifierKeys: committedVerifierKeys(profiles.emitter),
      maintenanceKeyFile: join(secretsDir, "unused-maintenance.json"),
      ttlSeconds: 1200,
    };
    await expect(
      runDeploy(services, { ...base, emitterSecretFile: emitterSecret, out: out("new.json") }),
    ).rejects.toThrow(/already exists; refusing to overwrite it/);
    await expect(
      runDeploy(services, {
        ...base,
        emitterSecretFile: join(secretsDir, "fresh.secret"),
        out: out("deploy-emitter.json"),
      }),
    ).rejects.toThrow(/already exists; choose a new path/);
    expect(submitted).toHaveLength(0);
    expect(existsSync(join(secretsDir, "fresh.secret"))).toBe(false);
  });
});

describe("publish", () => {
  it("one message: one package in one intent, found by identifier and verified from the raw bytes", () => {
    expect(single.stage).toBe("verified");
    expect(single.merged).toBe(false);
    expect(single.inclusion?.status).toBe("SUCCESS");
    expect(single.finalized.packages).toHaveLength(1);
    expect(single.finalized.packages[0]?.partsHex).toHaveLength(2);
    expect(single.packages).toEqual([
      { segment: single.finalized.packages[0]?.segment, parts: 2, verified: true, issues: [] },
    ]);
    expect(single.messages).toEqual([
      { bytes: 417, sha256: createHash("sha256").update(MESSAGE).digest("hex") },
    ]);
    const saved = readRecord<PublicationRecord>("publish-single.json");
    expect(saved.finalized.transactionHex).toBe(single.finalized.transactionHex);
    expect(saved.stage).toBe("verified");
  });

  it("several messages: ONE transaction, one intent each, every package verified", () => {
    expect(several.stage).toBe("verified");
    const segments = several.finalized.packages.map((pkg) => pkg.segment);
    expect(new Set(segments).size).toBe(2);
    expect(several.finalized.packages.map((pkg) => pkg.partsHex.length)).toEqual([1, 3]);
    expect(several.packages?.every((pkg) => pkg.verified)).toBe(true);
    const included = fake.entries.find((entry) => entry.hash === several.inclusion?.hash);
    expect(included?.identifiers.length).toBeGreaterThan(0);
    expect(publishLines.filter((line) => line.startsWith("package "))).toHaveLength(3);
  });

  it("the notice board's text format is the board client's", () => {
    for (const text of NOTICES) expect(encodeNoticeText(text)).toEqual(encodeNotice(text));
  });

  it("writes the record before submitting: a failing submission leaves the finalized record", async () => {
    const { services } = offlineServices(fake, {
      submitter: { submitTx: () => Promise.reject(new Error("node refused")) },
    });
    await expect(
      runPublish(services, {
        profile: profiles.emitter,
        generated: emitterModule,
        address: emitter.address,
        messages: [patternMessage(50)],
        secretFile: emitterSecret,
        maxParts: 8,
        ttlSeconds: 1200,
        out: out("publish-refused.json"),
      }),
    ).rejects.toThrow(/node refused/);
    const saved = readRecord<PublicationRecord>("publish-refused.json");
    expect(saved.stage).toBe("finalized");
    expect(saved.finalized.identifiers.length).toBeGreaterThan(0);
  });

  it("a dry run records and does not submit", async () => {
    const { services, submitted } = offlineServices(fake);
    const record = await runPublish(services, {
      profile: profiles.emitter,
      generated: emitterModule,
      address: emitter.address,
      messages: [patternMessage(100)],
      secretFile: emitterSecret,
      maxParts: 8,
      ttlSeconds: 1200,
      out: out("publish-dry.json"),
      dryRun: true,
    });
    expect(record.submittedId).toBeUndefined();
    expect(submitted).toHaveLength(0);
    expect(readRecord<PublicationRecord>("publish-dry.json").stage).toBe("finalized");
  });

  it("fails with a named reason when the transaction never shows up", async () => {
    const { services } = offlineServices(fake, {
      waitForInclusion: () => Promise.resolve(undefined),
    });
    await expect(
      runPublish(services, {
        profile: profiles.emitter,
        generated: emitterModule,
        address: emitter.address,
        messages: [patternMessage(50, 3)],
        secretFile: emitterSecret,
        maxParts: 8,
        ttlSeconds: 1200,
        out: out("publish-lost.json"),
      }),
    ).rejects.toThrow(CommandFailure);
    expect(readRecord<PublicationRecord>("publish-lost.json").stage).toBe("submitted");
  });

  it("refuses more parts than the cap before any proof", async () => {
    const { services, submitted } = offlineServices(fake);
    await expect(
      runPublish(services, {
        profile: profiles.emitter,
        generated: emitterModule,
        address: emitter.address,
        messages: [patternMessage(257 * 2)],
        secretFile: emitterSecret,
        maxParts: 2,
        ttlSeconds: 1200,
        out: out("publish-cap.json"),
      }),
    ).rejects.toThrow(/3 parts; the configured limit is 1..2/);
    expect(submitted).toHaveLength(0);
  });
});

describe("pin", () => {
  it("changes the board's state in a transaction of its own", () => {
    expect(pinned.stage).toBe("verified");
    expect(pinned.pinnedCount).toBe("1");
    expect(readRecord<PinRecord>("pin.json").stage).toBe("verified");
  });
});

// ---------------------------------------------------------------------------------
// main(): argument handling, with stand-in wallet and prover
// ---------------------------------------------------------------------------------

const WORDS = `${"abandon ".repeat(23)}diesel`;
const identity = publicIdentity(deriveWalletKeys(WORDS, NETWORK), NETWORK);
const balances: WalletBalances = { night: 5_000_000_000n, dust: 12n, shielded: {}, nightUtxos: [] };
const notSynced = new WalletNotSyncedError(
  {
    shielded: { applied: 1200n, highest: 5000n, connected: true },
    unshielded: { applied: 3n, highest: 3n, connected: true },
    dust: { applied: 40_000n, highest: 250_000n, connected: true },
  },
  3_600_000,
  "timed out after 60 min",
);

interface StandIn {
  readonly opened: WalletSessionOptions[];
  readonly closed: () => boolean;
  readonly openWallet: (options: WalletSessionOptions) => Promise<ToolWallet>;
}

const standIn = (
  behaviour: {
    readonly balances?: () => Promise<WalletBalances>;
    readonly synced?: () => Promise<unknown>;
  } = {},
): StandIn => {
  const opened: WalletSessionOptions[] = [];
  let closed = false;
  const wallet: ToolWallet = {
    identity,
    balances: behaviour.balances ?? (() => Promise.resolve(balances)),
    registerForDust: () => Promise.reject(new Error("not used")),
    synced: behaviour.synced ?? (() => Promise.resolve(undefined)),
    balancer: () => standInBalancer,
    submitter: () => ({
      submitTx: (tx: ledger.FinalizedTransaction) => {
        fake.include(tx, { applied: tx.eraseProofs() });
        return Promise.resolve(tx.identifiers()[0] ?? "");
      },
    }),
    coinPublicKey: () => "0".repeat(64),
    close: () => {
      closed = true;
      return Promise.resolve();
    },
  };
  return {
    opened,
    closed: () => closed,
    openWallet: (options) => {
      opened.push(options);
      return Promise.resolve(wallet);
    },
  };
};

const runMain = async (
  argv: string[],
  env: Record<string, string> = {},
  wallet: StandIn = standIn(),
): Promise<{ status: number; out: string; err: string }> => {
  const outLines: string[] = [];
  const errLines: string[] = [];
  const status = await main(
    argv,
    env,
    { out: (line) => outLines.push(line), err: (line) => errLines.push(line) },
    { openWallet: wallet.openWallet, prover: standInProver, requireProofs: false },
  );
  return { status, out: outLines.join("\n"), err: errLines.join("\n") };
};

const network = () => [
  "--network",
  NETWORK,
  "--indexer",
  served.indexerUrl,
  "--node",
  served.nodeUrl,
  "--proof-server",
  "http://127.0.0.1:6300",
  "--wallet-mnemonic-file",
  "/nonexistent/wallet.mnemonic",
];

describe("main: publish, deploy and pin", () => {
  it("publish with several messages of each kind: one transaction, one intent each (exit 0)", async () => {
    const file = join(outDir, "message.bin");
    writeFileSync(file, patternMessage(300, 5));
    const result = await runMain([
      "publish",
      ...network(),
      "--example",
      "emitter",
      "--contract",
      emitter.address,
      "--message",
      "hello",
      "--message-hex",
      "0x00ff",
      "--message-file",
      file,
      "--emitter-secret-file",
      emitterSecret,
      "--out",
      out("main-publish.json"),
      "--json",
    ]);
    expect(result.status).toBe(0);
    const record = JSON.parse(result.out) as PublicationRecord;
    expect(record.stage).toBe("verified");
    expect(record.messages.map((message) => message.bytes)).toEqual([5, 2, 300]);
    expect(record.finalized.packages.map((pkg) => pkg.partsHex.length)).toEqual([1, 1, 2]);
    expect(new Set(record.finalized.packages.map((pkg) => pkg.segment)).size).toBe(3);
    expect(
      record.finalized.packages[0]?.partsHex[0]?.startsWith(
        toHex(new TextEncoder().encode("hello")),
      ),
    ).toBe(true);
    expect(result.err).toContain("recorded before submission");
  });

  it("deploy and pin through main (exit 0)", async () => {
    const deployed = await runMain([
      "deploy",
      ...network(),
      "--example",
      "notice-board",
      "--emitter-secret-file",
      join(secretsDir, "main-board.secret"),
      "--maintenance-key-file",
      join(secretsDir, "main-board-maintenance.json"),
      "--out",
      out("main-deploy.json"),
    ]);
    expect(deployed.status).toBe(0);
    const address = readRecord<DeploymentRecord>("main-deploy.json").address;
    const pin = await runMain([
      "pin",
      ...network(),
      "--example",
      "notice-board",
      "--contract",
      address,
      "--digest",
      "11".repeat(32),
      "--emitter-secret-file",
      join(secretsDir, "main-board.secret"),
      "--out",
      out("main-pin.json"),
    ]);
    expect(pin.status).toBe(0);
    expect(readRecord<PinRecord>("main-pin.json").pinnedCount).toBe("1");
  });

  it.each([
    [[], 2],
    [["--help"], 0],
    [["frobnicate"], 2],
    [["publish", "--bogus"], 2],
    [["publish", "--example", "emitter", "--contract", "12", "--out", "x.json"], 2],
    [["publish", "--example", "other", "--out", "x.json"], 2],
    [["publish", "--example", "emitter", "--contract", "ab".repeat(32), "--out", "x.json"], 2],
    [["pin", "--example", "emitter", "--contract", "ab".repeat(32), "--out", "x.json"], 2],
    [["deploy", "--example", "emitter", "--message", "x", "--out", "x.json"], 2],
    [["deploy", "--example", "emitter", "--out", "x.json", "--out", "y.json"], 2],
  ])("%j exits %i", async (argv, expected) => {
    const wallet = standIn();
    const result = await runMain(argv, {}, wallet);
    expect(result.status).toBe(expected);
    if (expected === 2 && argv.length > 0) expect(result.err).toMatch(/^error: /);
    expect(wallet.opened).toHaveLength(0);
  });

  it("publish without a message is a usage error before the wallet opens", async () => {
    const wallet = standIn();
    const result = await runMain(
      [
        "publish",
        ...network(),
        "--example",
        "emitter",
        "--contract",
        emitter.address,
        "--emitter-secret-file",
        emitterSecret,
        "--out",
        out("never.json"),
      ],
      {},
      wallet,
    );
    expect(result.status).toBe(2);
    expect(result.err).toContain("give at least one --message");
    expect(wallet.opened).toHaveLength(0);
  });

  it("--help lists every command, flag and environment variable", async () => {
    const result = await runMain(["--help"]);
    for (const text of [
      "funding",
      "deploy",
      "publish",
      "pin",
      "--fee-blocks-margin CMSE_FEE_BLOCKS_MARGIN (5; an integer from 0 to 100)",
      "CMSE_WALLET_MNEMONIC_FILE",
      "CMSE_EMITTER_SECRET_FILE",
      "CMSE_MAINTENANCE_KEY_FILE",
      "CMSE_WALLET_CACHE_FILE",
      "CMSE_SYNC_TIMEOUT_MINUTES",
      "CMSE_PROOF_SERVER_URL",
      "CMSE_PROOF_CONCURRENCY",
      "CMSE_INDEXER_URL",
      "CMSE_INDEXER_WS_URL",
      "CMSE_NODE_URL",
      "CMSE_NETWORK",
      "CMSE_ZK_DIR",
      "--allow-remote-prover",
      "--dry-run",
      "--max-parts",
    ]) {
      expect(result.out).toContain(text);
    }
  });

  it("refuses a remote proof server and explains why", async () => {
    const result = await runMain([
      "funding",
      "--proof-server",
      "http://prover.example.com:6300",
      "--wallet-mnemonic-file",
      "/nonexistent",
    ]);
    expect(result.status).toBe(2);
    expect(result.err).toContain("would see your witness secrets");
  });
});

describe("main: wallet sync, cache and fee margin (stand-in wallet)", () => {
  const funding = () => ["funding", ...network()];

  it("funding prints 'not synced' with the progress instead of balances and exits 1", async () => {
    const wallet = standIn({ balances: () => Promise.reject(notSynced) });
    const result = await runMain(
      [
        ...funding(),
        "--sync-timeout-minutes",
        "90",
        "--wallet-cache-file",
        "/elsewhere/cache.json",
      ],
      {},
      wallet,
    );
    expect(result.status).toBe(1);
    expect(result.out).toContain(`unshielded address ${identity.unshieldedAddress}`);
    expect(result.out).toContain(
      "not synced         shielded 1200/5000, unshielded 3/3, dust 40000/250000 (applied/highest index); timed out after 60 min",
    );
    expect(result.out).not.toContain("STAR");
    expect(result.out).not.toContain("SPECK");
    expect(result.err).toContain(
      "failed: the wallet is not synced, so its balances are unknown (not zero)",
    );
    expect(result.out + result.err).not.toContain("abandon");
    expect(wallet.closed()).toBe(true);
    expect(wallet.opened[0]?.syncTimeoutMs).toBe(90 * 60_000);
    expect(wallet.opened[0]?.stateCacheFile).toBe("/elsewhere/cache.json");
  });

  it("funding prints balances after a complete sync; timeout and cache also come from CMSE_*", async () => {
    const withEnv = standIn();
    const result = await runMain(
      funding(),
      { CMSE_SYNC_TIMEOUT_MINUTES: "5", CMSE_WALLET_CACHE_FILE: "/elsewhere/env-cache.json" },
      withEnv,
    );
    expect(result.status).toBe(0);
    expect(result.out).toContain("NIGHT              5000000000 STAR (0 UTxO)");
    expect(result.out).toContain("DUST               12 SPECK");
    expect(withEnv.opened[0]?.syncTimeoutMs).toBe(5 * 60_000);
    expect(withEnv.opened[0]?.stateCacheFile).toBe("/elsewhere/env-cache.json");
    const defaults = standIn();
    expect((await runMain(funding(), {}, defaults)).status).toBe(0);
    expect(defaults.opened[0]?.syncTimeoutMs).toBe(60 * 60_000);
    expect(defaults.opened[0]).not.toHaveProperty("stateCacheFile");
  });

  it("the fee margin defaults to 5 blocks and comes from the flag or CMSE_FEE_BLOCKS_MARGIN, the flag first", async () => {
    const defaults = standIn();
    expect((await runMain(funding(), {}, defaults)).status).toBe(0);
    expect(defaults.opened[0]?.feeBlocksMargin).toBe(5);
    const fromEnv = standIn();
    expect((await runMain(funding(), { CMSE_FEE_BLOCKS_MARGIN: "12" }, fromEnv)).status).toBe(0);
    expect(fromEnv.opened[0]?.feeBlocksMargin).toBe(12);
    const flagFirst = standIn();
    expect(
      (
        await runMain(
          [...funding(), "--fee-blocks-margin", "0"],
          { CMSE_FEE_BLOCKS_MARGIN: "12" },
          flagFirst,
        )
      ).status,
    ).toBe(0);
    expect(flagFirst.opened[0]?.feeBlocksMargin).toBe(0);
    const highest = standIn();
    expect((await runMain([...funding(), "--fee-blocks-margin=100"], {}, highest)).status).toBe(0);
    expect(highest.opened[0]?.feeBlocksMargin).toBe(100);
  });

  it.each(["-1", "101", "1.5", "1e1", "five", " "])(
    "refuses the fee margin %j (not an integer from 0 to 100) before opening a wallet",
    async (margin) => {
      for (const [argv, env] of [
        [[...funding(), "--fee-blocks-margin", margin], {}],
        [funding(), { CMSE_FEE_BLOCKS_MARGIN: margin }],
      ] as const) {
        const wallet = standIn();
        const result = await runMain([...argv], env, wallet);
        if (margin.trim() === "" && argv.length === funding().length) {
          // An empty or blank variable counts as unset: the default applies.
          expect(result.status).toBe(0);
          expect(wallet.opened[0]?.feeBlocksMargin).toBe(5);
          continue;
        }
        expect(result.status).toBe(2);
        expect(result.err).toContain("--fee-blocks-margin must be an integer from 0 to 100");
        expect(wallet.opened).toHaveLength(0);
      }
    },
  );

  it("refuses a sync timeout outside 1..1440 minutes before opening a wallet", async () => {
    const wallet = standIn();
    const result = await runMain([...funding(), "--sync-timeout-minutes", "0"], {}, wallet);
    expect(result.status).toBe(2);
    expect(result.err).toContain("--sync-timeout-minutes must be an integer from 1 to 1440");
    expect(wallet.opened).toHaveLength(0);
  });

  it("every other command stops with 'not synced' (exit 1) and closes the wallet", async () => {
    const wallet = standIn({ synced: () => Promise.reject(notSynced) });
    const result = await runMain(
      [
        "deploy",
        ...network(),
        "--example",
        "emitter",
        "--emitter-secret-file",
        join(secretsDir, "never.secret"),
        "--maintenance-key-file",
        join(secretsDir, "never-maintenance.json"),
        "--out",
        out("never-deploy.json"),
      ],
      {},
      wallet,
    );
    expect(result.status).toBe(1);
    expect(result.err).toMatch(
      /^not synced: wallet not synced after 60 min \(timed out after 60 min\): shielded 1200\/5000/u,
    );
    expect(wallet.closed()).toBe(true);
    expect(wallet.opened[0]?.feeBlocksMargin).toBe(5);
    expect(existsSync(join(secretsDir, "never.secret"))).toBe(false);
  });
});

describe("funding output", () => {
  it("prints only the public identity and balances", async () => {
    const keys = deriveWalletKeys(WORDS, NETWORK);
    const lines: string[] = [];
    const report = await runFunding(
      {
        identity,
        balances: () =>
          Promise.resolve({
            night: 5_000_000_000n,
            dust: 12n,
            shielded: {},
            nightUtxos: [
              {
                value: 5_000_000_000n,
                intentHash: "ab".repeat(32),
                outputNo: 0,
                ctime: "2026-09-23T00:00:00.000Z",
                registeredForDustGeneration: false,
              },
            ],
          }),
        registerForDust: (mode) => Promise.resolve({ mode, unregistered: 1, fee: 7n }),
      },
      { registerDust: "estimate" },
      (line) => lines.push(line),
    );
    const output = lines.join("\n");
    expect(output).toContain(identity.unshieldedAddress);
    expect(output).toContain("NIGHT              5000000000 STAR (1 UTxO)");
    expect(output).toContain("DUST registration  estimate: 1 unregistered UTxO, fee 7 SPECK");
    expect(output).not.toContain("abandon");
    expect(output).not.toContain(keys.unshieldedKeystore.getSecretKey().toString("hex"));
    expect(report.dustRegistration?.fee).toBe(7n);
  });
});
