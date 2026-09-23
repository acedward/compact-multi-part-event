/**
 * CLI commands end to end over the in-process ledger: `deploy` (emitter secret created
 * in a protected file and never printed, address recorded before submission, deployed
 * state checked), `publish` (record written before submission, inclusion tracked by
 * identifier, verified from raw bytes), and `verify` through `main()` against a served
 * fake indexer and node: levels 1-3, the node cross-check, not-found, incomplete and
 * key-mismatch outcomes with their exit statuses, and the offline raw-bytes mode;
 * `funding` and the other wallet commands through `main()` with a stand-in wallet: an
 * incomplete sync prints "not synced" with its progress (never balances) and exits 1,
 * and the sync timeout and cache flags/environment variables reach the wallet.
 */
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readWitnessSecret } from "../src/adapters/secrets.js";
import {
  deriveWalletKeys,
  publicIdentity,
  type WalletBalances,
  type WalletSessionOptions,
} from "../src/adapters/wallet.js";
import { WalletNotSyncedError } from "../src/adapters/wallet-sync.js";
import { encodePublication } from "../src/codec/index.js";
import {
  CommandFailure,
  type DeploymentRecord,
  type PublicationOutcome,
  runDeploy,
  runPublish,
} from "../src/cli/commands.js";
import {
  committedVerifierKeys,
  contractProfiles,
  type GeneratedModule,
  loadGeneratedModule,
} from "../src/cli/contracts.js";
import { type CliWallet, main } from "../src/cli/main.js";
import { buildPublicationTransaction } from "../src/transaction/index.js";
import { patternMessage, toHex } from "./helpers/bytes.js";
import { FakeIndexer } from "./helpers/fake-indexer.js";
import {
  assembleIntent,
  emitterBinding,
  emitterTrace,
  LocalChain,
  NETWORK,
  transcriptsAt,
} from "./helpers/ledger.js";
import { offlineServices, standInBalancer } from "./helpers/offline-services.js";

const profile = contractProfiles().emitter;
const secretsDir = mkdtempSync(join(tmpdir(), "cmse-cli-secrets-"));
const outDir = mkdtempSync(join(tmpdir(), "cmse-cli-out-"));
const secretFile = join(secretsDir, "emitter.secret");
const MESSAGE = patternMessage(417);

let generated: GeneratedModule;
let chain: LocalChain;
let fake: FakeIndexer;
let deployment: DeploymentRecord;
let deployLines: string[];
let publication: PublicationOutcome;
let publishLines: string[];
let served: { indexerUrl: string; nodeUrl: string; close(): Promise<void> };

const run = async (argv: string[]): Promise<{ status: number; out: string; err: string }> => {
  const out: string[] = [];
  const err: string[] = [];
  const status = await main(
    argv,
    {},
    { out: (line) => out.push(line), err: (line) => err.push(line) },
  );
  return { status, out: out.join("\n"), err: err.join("\n") };
};

beforeAll(async () => {
  generated = await loadGeneratedModule(profile);
  chain = new LocalChain();
  fake = new FakeIndexer(chain);
  const deployed = offlineServices(fake);
  deployment = await runDeploy(deployed.services, {
    profile,
    generated,
    verifierKeys: committedVerifierKeys(profile),
    emitterSecretFile: secretFile,
    maintenanceKeyFile: join(secretsDir, "maintenance.json"),
    ttlSeconds: 1200,
    out: join(outDir, "deploy.json"),
  });
  deployLines = deployed.lines;
  const published = offlineServices(fake);
  publication = await runPublish(published.services, {
    profile,
    generated,
    address: deployment.address,
    message: MESSAGE,
    secretFile,
    maxParts: 8,
    ttlSeconds: 1200,
    recordOut: join(outDir, "publication.json"),
  });
  publishLines = published.lines;
  served = await fake.serve();
});

afterAll(async () => {
  await served.close();
});

describe("deploy", () => {
  it("creates the emitter secret in a protected file and never prints or records it", () => {
    expect(statSync(secretFile).mode & 0o777).toBe(0o600);
    const secretHex = toHex(readWitnessSecret(secretFile));
    const everything = [
      ...deployLines,
      ...publishLines,
      readFileSync(join(outDir, "deploy.json"), "utf8"),
      readFileSync(join(outDir, "publication.json"), "utf8"),
    ].join("\n");
    expect(everything).not.toContain(secretHex);
    expect(everything).not.toContain(
      (JSON.parse(readFileSync(join(secretsDir, "maintenance.json"), "utf8")) as { value: string })
        .value,
    );
  });

  it("records the address before submission and ends verified", () => {
    expect(deployLines[0]).toBe(
      `contract address   ${deployment.address} (recorded before submission)`,
    );
    const record = JSON.parse(
      readFileSync(join(outDir, "deploy.json"), "utf8"),
    ) as DeploymentRecord;
    expect(record.stage).toBe("verified");
    expect(record.operations).toEqual(["emitPart"]);
    expect(record.verifierKeySha256.emitPart).toBe(
      "a14b8e2d443e2f2b60b24326097cdad929333ee998f00e503d30e8e01a0ca6f2",
    );
    expect(record.emitterAuthority).toMatch(/^[0-9a-f]{64}$/);
    expect(record.inclusion?.status).toBe("SUCCESS");
    expect(chain.state.index(deployment.address)?.maintenanceAuthority.threshold).toBe(1);
  });

  it("refuses to overwrite an existing emitter secret before building anything", async () => {
    const { services, submitted } = offlineServices(fake);
    await expect(
      runDeploy(services, {
        profile,
        generated,
        verifierKeys: committedVerifierKeys(profile),
        emitterSecretFile: secretFile,
        maintenanceKeyFile: join(secretsDir, "maintenance-2.json"),
        ttlSeconds: 1200,
      }),
    ).rejects.toThrow(/already exists; refusing to overwrite it/);
    expect(submitted).toHaveLength(0);
  });
});

describe("publish", () => {
  it("publishes, finds the inclusion by identifier and verifies it from the raw bytes", () => {
    expect(publication.verified).toBe(true);
    expect(publication.merged).toBe(false);
    expect(publication.inclusion?.status).toBe("SUCCESS");
    expect(publication.record.requestIdHex).toBe(
      "fcde97e961102a0617cdf6d4628d58d425326b6ff634585e130c9a2509da071b",
    );
    expect(publication.normalizedCost.blockUsage).toBeGreaterThan(0);
    const saved = JSON.parse(
      readFileSync(join(outDir, "publication.json"), "utf8"),
    ) as PublicationOutcome;
    expect(saved.record.transactionHex).toBe(publication.record.transactionHex);
  });

  it("with --dry-run style options it records and does not submit", async () => {
    const { services, submitted } = offlineServices(fake);
    const outcome = await runPublish(services, {
      profile,
      generated,
      address: deployment.address,
      message: patternMessage(100),
      secretFile,
      maxParts: 8,
      ttlSeconds: 1200,
      dryRun: true,
    });
    expect(outcome.submittedId).toBeUndefined();
    expect(submitted).toHaveLength(0);
  });

  it("fails with a named reason when the transaction never shows up", async () => {
    const { services } = offlineServices(fake, {
      waitForInclusion: () => Promise.resolve(undefined),
    });
    await expect(
      runPublish(services, {
        profile,
        generated,
        address: deployment.address,
        message: patternMessage(50),
        secretFile,
        maxParts: 8,
        ttlSeconds: 1200,
      }),
    ).rejects.toThrow(CommandFailure);
  });
});

describe("verify (main)", () => {
  const verifyArgs = (extra: string[] = []) => [
    "verify",
    "--network",
    NETWORK,
    "--indexer",
    served.indexerUrl,
    "--node",
    served.nodeUrl,
    "--contract",
    deployment.address,
    "--tx",
    publication.inclusion?.hash ?? "",
    ...extra,
  ];

  it("verifies levels 1-3 with the node cross-check (exit 0)", async () => {
    const result = await run(verifyArgs());
    expect(result.err).toBe("");
    expect(result.status).toBe(0);
    expect(result.out).toContain(
      "L1 OK   request fcde97e961102a0617cdf6d4628d58d425326b6ff634585e130c9a2509da071b: 3 parts, 417 bytes",
    );
    expect(result.out).toContain("L2 OK   status SUCCESS; 3 guaranteed-only emitPart calls");
    expect(result.out).toContain("L2 OK   1 publication(s) match Level 1");
    expect(result.out).toMatch(/L2 OK {3}the node's block \d+ holds the raw bytes \(extrinsic 1\)/);
    expect(result.out).toContain(
      "L3 OK   deployed emitPart verifier key equals the repository's (SHA-256 a14b8e2d443e2f2b60b24326097cdad929333ee998f00e503d30e8e01a0ca6f2)",
    );
    expect(result.out).toContain("verified up to level 3");
  });

  it("prints machine-readable output with --json", async () => {
    const result = await run([...verifyArgs(["--level", "2"]), "--json"]);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.out) as {
      level: number;
      publications: { messageHex: string }[];
    };
    expect(report.level).toBe(2);
    expect(report.publications[0]?.messageHex).toBe(toHex(MESSAGE));
  });

  it("fails Level 3 on a different expected verifier key (exit 1)", async () => {
    const other = join(outDir, "other.verifier");
    const key = new Uint8Array(readFileSync("contracts/keys/emitter/emitPart.verifier"));
    key[200] = (key[200] ?? 0) ^ 1;
    writeFileSync(other, key);
    const result = await run(verifyArgs(["--verifier-key", other]));
    expect(result.status).toBe(1);
    expect(result.out).toContain("L3 FAIL deployed emitPart verifier key");
    expect(result.out).toContain("verified up to level 2");
  });

  it("reports not found for an unknown transaction or another contract (exit 3)", async () => {
    const unknown = await run([
      "verify",
      "--indexer",
      served.indexerUrl,
      "--network",
      NETWORK,
      "--contract",
      deployment.address,
      "--tx",
      "ab".repeat(32),
    ]);
    expect(unknown.status).toBe(3);
    const other = await run(
      verifyArgs().map((arg) => (arg === deployment.address ? "cd".repeat(32) : arg)),
    );
    expect(other.status).toBe(3);
  });

  it("fails Level 1 for an incomplete publication (exit 1)", async () => {
    const encoded = encodePublication(patternMessage(417, 9));
    const secret = readWitnessSecret(secretFile);
    const specs = [];
    for (const part of encoded.parts.slice(0, 2)) {
      specs.push({
        trace: await emitterTrace(chain, deployment.address, secret, encoded.requestId, part.tail),
      });
    }
    const built = await buildPublicationTransaction(
      chain.source(),
      emitterBinding(secret),
      { network: NETWORK, emitter: deployment.address, coinPublicKey: "0".repeat(64) },
      encoded,
    );
    const transcripts = transcriptsAt(built.transaction, built.expected.segment);
    const partial = assembleIntent(
      chain,
      deployment.address,
      4242,
      specs.map((spec, index) => ({ ...spec, guaranteed: transcripts[index] })),
    );
    const entry = fake.include(partial.eraseProofs());
    const result = await run(
      verifyArgs().map((arg) => (arg === publication.inclusion?.hash ? entry.hash : arg)),
    );
    expect(result.status).toBe(1);
    expect(result.out).toMatch(/L1 FAIL incomplete request/i);
    expect(result.out).toContain("verified up to level 0");
  });

  it("verifies saved raw bytes offline, and refuses a failure status", async () => {
    const rawFile = join(outDir, "raw.hex");
    writeFileSync(rawFile, `${publication.inclusion?.rawHex ?? ""}\n`);
    const base = [
      "verify",
      "--network",
      NETWORK,
      "--contract",
      deployment.address,
      "--raw-file",
      rawFile,
      "--tx",
      publication.inclusion?.hash ?? "",
      "--level",
      "2",
    ];
    const ok = await run([...base, "--status", "SUCCESS"]);
    expect(ok.status).toBe(0);
    expect(ok.out).toContain("L1 OK   request fcde97e9");
    const failed = await run([...base, "--status", "FAILURE"]);
    expect(failed.status).toBe(1);
  });
});

describe("usage (main)", () => {
  it.each([
    [[], 2],
    [["--help"], 0],
    [["frobnicate"], 2],
    [["verify", "--bogus"], 2],
    [["verify", "--contract", "12"], 2],
    [["publish", "--contract", "ab".repeat(32), "--message-hex", "00"], 2],
    [
      [
        "publish",
        "--contract",
        "ab".repeat(32),
        "--message-hex",
        "00",
        "--proof-server",
        "http://prover.example.com:6300",
      ],
      2,
    ],
  ])("%j exits %i", async (argv, expected) => {
    const result = await run(argv);
    expect(result.status).toBe(expected);
    if (expected === 2 && argv.length > 0) expect(result.err).toMatch(/^error: /);
  });

  it("explains why a remote proof server is refused", async () => {
    const result = await run([
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

describe("wallet sync (main, stand-in wallet)", () => {
  const WORDS = `${"abandon ".repeat(23)}diesel`;
  const identity = publicIdentity(deriveWalletKeys(WORDS, NETWORK), NETWORK);
  const notSynced = new WalletNotSyncedError(
    {
      shielded: { applied: 1200n, highest: 5000n, connected: true },
      unshielded: { applied: 3n, highest: 3n, connected: true },
      dust: { applied: 40_000n, highest: 250_000n, connected: true },
    },
    3_600_000,
    "timed out after 60 min",
  );
  const balances: WalletBalances = {
    night: 5_000_000_000n,
    dust: 12n,
    shielded: {},
    nightUtxos: [],
  };

  interface StandIn {
    readonly opened: WalletSessionOptions[];
    readonly closed: () => boolean;
    readonly openWallet: (options: WalletSessionOptions) => Promise<CliWallet>;
  }

  const standIn = (behaviour: {
    readonly balances?: () => Promise<WalletBalances>;
    readonly synced?: () => Promise<unknown>;
  }): StandIn => {
    const opened: WalletSessionOptions[] = [];
    let closed = false;
    const wallet: CliWallet = {
      identity,
      balances: behaviour.balances ?? (() => Promise.resolve(balances)),
      registerForDust: () => Promise.reject(new Error("not used")),
      synced: behaviour.synced ?? (() => Promise.resolve(undefined)),
      balancer: () => standInBalancer,
      submitter: () => ({ submitTx: () => Promise.reject(new Error("not used")) }),
      coinPublicKey: () => identity.coinPublicKey,
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

  const runWith = async (
    argv: string[],
    env: Record<string, string>,
    wallet: StandIn,
  ): Promise<{ status: number; out: string; err: string }> => {
    const out: string[] = [];
    const err: string[] = [];
    const status = await main(
      argv,
      env,
      { out: (line) => out.push(line), err: (line) => err.push(line) },
      { openWallet: wallet.openWallet },
    );
    return { status, out: out.join("\n"), err: err.join("\n") };
  };

  const fundingArgs = () => [
    "funding",
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

  it("funding prints 'not synced' with the progress instead of balances and exits 1", async () => {
    const wallet = standIn({ balances: () => Promise.reject(notSynced) });
    const result = await runWith(
      [
        ...fundingArgs(),
        "--sync-timeout-minutes",
        "90",
        "--wallet-cache-file",
        "/elsewhere/cache.json",
      ],
      {},
      wallet,
    );
    expect(result.status).toBe(1);
    // The public addresses are still printed: they are what a faucet needs.
    expect(result.out).toContain(`unshielded address ${identity.unshieldedAddress}`);
    expect(result.out).toContain(
      "not synced         shielded 1200/5000, unshielded 3/3, dust 40000/250000 (applied/highest index); timed out after 60 min",
    );
    expect(result.out).not.toMatch(/^NIGHT /mu);
    expect(result.out).not.toMatch(/^DUST {15}/mu);
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
    const withEnv = standIn({});
    const result = await runWith(
      fundingArgs(),
      { CMSE_SYNC_TIMEOUT_MINUTES: "5", CMSE_WALLET_CACHE_FILE: "/elsewhere/env-cache.json" },
      withEnv,
    );
    expect(result.status).toBe(0);
    expect(result.out).toContain("NIGHT              5000000000 STAR (0 UTxO)");
    expect(result.out).toContain("DUST               12 SPECK");
    expect(result.out).not.toContain("not synced");
    expect(withEnv.opened[0]?.syncTimeoutMs).toBe(5 * 60_000);
    expect(withEnv.opened[0]?.stateCacheFile).toBe("/elsewhere/env-cache.json");

    const defaults = standIn({});
    expect((await runWith(fundingArgs(), {}, defaults)).status).toBe(0);
    expect(defaults.opened[0]?.syncTimeoutMs).toBe(60 * 60_000);
    expect(defaults.opened[0]).not.toHaveProperty("stateCacheFile");
  });

  it("refuses a sync timeout outside 1..1440 minutes before opening a wallet", async () => {
    const wallet = standIn({});
    const result = await runWith([...fundingArgs(), "--sync-timeout-minutes", "0"], {}, wallet);
    expect(result.status).toBe(2);
    expect(result.err).toContain("--sync-timeout-minutes must be an integer from 1 to 1440");
    expect(wallet.opened).toHaveLength(0);
  });

  it("every other wallet command stops with 'not synced' (exit 1) and closes the wallet", async () => {
    const wallet = standIn({ synced: () => Promise.reject(notSynced) });
    const result = await runWith(
      [
        "deploy-consumer",
        ...fundingArgs().slice(1),
        "--maintenance-key-file",
        "/nonexistent/maintenance.json",
      ],
      {},
      wallet,
    );
    expect(result.status).toBe(1);
    expect(result.err).toMatch(
      /^not synced: wallet not synced after 60 min \(timed out after 60 min\): shielded 1200\/5000/u,
    );
    expect(wallet.closed()).toBe(true);
  });
});
