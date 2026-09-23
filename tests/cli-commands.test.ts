/**
 * CLI commands end to end over the in-process ledger: `deploy` (emitter secret created
 * in a protected file and never printed, address recorded before submission, deployed
 * state checked), `publish` (record written before submission, inclusion tracked by
 * identifier, verified from raw bytes), and `verify` through `main()` against a served
 * fake indexer and node: levels 1-3, the node cross-check, not-found, incomplete and
 * key-mismatch outcomes with their exit statuses, and the offline raw-bytes mode.
 */
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readWitnessSecret } from "../src/adapters/secrets.js";
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
import { main } from "../src/cli/main.js";
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
import { offlineServices } from "./helpers/offline-services.js";

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
