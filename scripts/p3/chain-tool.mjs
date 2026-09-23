// P3 live-run tool for the steps the `cmse` CLI does not cover. It uses the built library
// (`dist/`), so run `yarn build` first. Public records only; secrets are read from the
// protected files given by path and never printed.
//
//   node scripts/p3/chain-tool.mjs rejections --emitter <addr> --consumer <addr>
//        --coin-public-key <hex> --owner-secret-file <p> --m1-record <m1.json> --m1-tx <hash>
//        --out <rejections.json>
//     Local failure stages (no wallet, nothing submitted): wrong emitter secret, consumer
//     emission of an unregistered request ID and with a wrong owner secret, a 9-part
//     message under the default cap 8, a tampered finalized record, and the reader over
//     M1's live events with parts missing or duplicated under another identity.
//   node scripts/p3/chain-tool.mjs release --contract <consumer> --message-hex <hex>
//        --owner-secret-file <p> --out <record.json>   [wallet flags]
//   node scripts/p3/chain-tool.mjs merge-sealed --contract <emitter> --emitter-secret-file <p>
//        --message-a-hex <hex> --message-b-hex <hex> --out <record.json> [--dry-run] [wallet flags]
//     Q26: prove and bind (seal) two publications WITHOUT fees, merge the sealed
//     transactions, check offline that both publication intents are unchanged, then
//     balance the merged sealed transaction once (`balanceFinalizedTransaction`) and submit.
//   node scripts/p3/chain-tool.mjs replay --record <publication.json> --out <record.json>
//        [wallet flags]
//     Resubmit an already included publication's finalized bytes; the node is expected to
//     refuse them.
//
// Wallet flags: --wallet-mnemonic-file <p> [--wallet-cache-file <p>] --proof-server <url>
//   [--indexer <url>] [--indexer-ws <url>] [--node <url>]
import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

import { ContractState as RuntimeContractState } from "@midnight-ntwrk/compact-runtime";
import * as ledger from "@midnightntwrk/ledger-v9";
import { NoOpTransactionHistoryStorage } from "@midnightntwrk/wallet-sdk-abstractions";
import { DustWallet } from "@midnightntwrk/wallet-sdk-dust-wallet";
import { WalletFacade } from "@midnightntwrk/wallet-sdk-facade";
import { ShieldedWallet } from "@midnightntwrk/wallet-sdk-shielded";
import { PublicKey, UnshieldedWallet } from "@midnightntwrk/wallet-sdk-unshielded-wallet";

import {
  IndexerClient,
  indexerStateSource,
  ledgerParametersFromHex,
  publicEventsFromIndexer,
  waitForTransaction,
} from "../../dist/adapters/indexer.js";
import { proofServerProver } from "../../dist/adapters/prover.js";
import { readWitnessSecret } from "../../dist/adapters/secrets.js";
import { deriveWalletKeys, publicIdentity, readMnemonicFile } from "../../dist/adapters/wallet.js";
import { loadWalletCache } from "../../dist/adapters/wallet-cache.js";
import { formatSyncProgress, waitForCompleteSync } from "../../dist/adapters/wallet-sync.js";
import { zkConfigForContract } from "../../dist/adapters/zk-config.js";
import { bytesToHex, hexToBytes } from "../../dist/codec/bytes.js";
import { readPublications } from "../../dist/codec/reader.js";
import {
  deserializeTransaction,
  verifyPublicationTransaction,
} from "../../dist/codec/raw-transaction.js";
import { encodePublication } from "../../dist/codec/writer.js";
import {
  committedVerifierKeys,
  contractProfiles,
  loadGeneratedModule,
} from "../../dist/cli/contracts.js";
import { emitterWitnesses, messageOwnerWitnesses } from "../../dist/contract/index.js";
import {
  assertPublicationIntent,
  bindingFromContract,
  blockFullnessCheck,
  buildCircuitCallTransaction,
  buildPublicationTransaction,
  callIntentCheck,
  finalizeTransaction,
  locatePublication,
  PublicationCheckError,
  submitPublication,
  submitSavedTransaction,
} from "../../dist/transaction/index.js";

// ---------------------------------------------------------------------------------------
// arguments and output
// ---------------------------------------------------------------------------------------

const [command, ...rest] = process.argv.slice(2);
const flags = new Map();
for (let index = 0; index < rest.length; index += 1) {
  const name = rest[index];
  if (!name.startsWith("--")) throw new Error(`unexpected argument ${name}`);
  const next = rest[index + 1];
  if (next === undefined || next.startsWith("--")) {
    flags.set(name.slice(2), true);
  } else {
    flags.set(name.slice(2), next);
    index += 1;
  }
}
const flag = (name, fallback) => {
  const value = flags.get(name);
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`--${name} is required`);
  }
  return value;
};

const NETWORK = "stagenet";
const indexerUrl = flag("indexer", "https://indexer.stagenet.shielded.tools/api/v4/graphql");
const indexerWsUrl = flag("indexer-ws", "wss://indexer.stagenet.shielded.tools/api/v4/graphql/ws");
const nodeUrl = flag("node", "https://rpc.stagenet.shielded.tools");
const indexer = new IndexerClient({ url: indexerUrl });
const source = indexerStateSource(indexer);
const log = (line) => console.error(`${new Date().toISOString()} ${line}`);
// The error and its cause chain (the wallet SDK wraps the node's answer).
const errorText = (error, depth = 0) => {
  if (depth > 6 || error === undefined || error === null) return "";
  const text =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : typeof error === "object"
        ? (() => {
            try {
              return JSON.stringify(error, (_, value) =>
                typeof value === "bigint" ? String(value) : value,
              ).slice(0, 2000);
            } catch {
              return String(error);
            }
          })()
        : String(error);
  const fiberCause =
    typeof error === "object" ? error[Symbol.for("effect/Runtime/FiberFailure/Cause")] : undefined;
  const cause =
    typeof error === "object"
      ? (fiberCause ?? error.cause ?? error.error ?? error.defect)
      : undefined;
  const next = cause === undefined ? "" : errorText(cause, depth + 1);
  return next === "" ? text : `${text} <- ${next}`;
};

const jsonSafe = (value) => {
  if (typeof value === "bigint") return value.toString(10);
  if (value instanceof Uint8Array) return bytesToHex(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonSafe(item)]));
  }
  return value;
};
const writeRecord = (path, record) => {
  const temporary = `${path}.tmp-${String(process.pid)}`;
  writeFileSync(temporary, `${JSON.stringify(jsonSafe(record), null, 2)}\n`);
  renameSync(temporary, path);
};

const messageFromHex = (name) => hexToBytes(String(flag(name)).trim().toLowerCase());

const proverFor = (profile) =>
  proofServerProver({
    url: flag("proof-server"),
    zkConfig: zkConfigForContract({
      artifactDir: profile.zkDir,
      expectedVerifierKeys: committedVerifierKeys(profile),
    }),
    maxConcurrent: 4,
    onRetry: (event) => log(`prover retry ${event.endpoint} attempt ${String(event.attempt)}`),
  });

const intentBytes = (tx, segment) => {
  const intent = tx.intents?.get(segment);
  return intent === undefined ? undefined : bytesToHex(intent.serialize());
};
const intentHash = (tx, segment) => tx.intents?.get(segment)?.intentHash(segment);
const segmentsOf = (tx) => [...(tx.intents?.keys() ?? [])].sort((a, b) => a - b);

// ---------------------------------------------------------------------------------------
// wallet (the facade itself: the Q26 merge needs `balanceFinalizedTransaction`)
// ---------------------------------------------------------------------------------------

const wsUrl = (httpUrl) => {
  const url = new URL(httpUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url;
};

const openWallet = async () => {
  const latest = await indexer.latestBlock();
  const dustParameters = ledgerParametersFromHex(latest.ledgerParametersHex).dust;
  const keys = deriveWalletKeys(readMnemonicFile(flag("wallet-mnemonic-file")), NETWORK);
  const identity = publicIdentity(keys, NETWORK);
  try {
    let snapshots;
    const cacheFile = flags.get("wallet-cache-file");
    if (typeof cacheFile === "string") {
      const cached = loadWalletCache(cacheFile, identity);
      if (cached.status === "restorable") {
        snapshots = cached.snapshots;
        log(`wallet cache restoring the state saved at ${cached.savedAt} (read only; not saved)`);
      }
    }
    const restoreOr = (snapshot, restore, fresh) => {
      if (snapshot !== undefined) {
        try {
          return restore(snapshot);
        } catch {
          log("wallet cache: a sub-wallet could not be restored; syncing it from the start");
        }
      }
      return fresh();
    };
    const facade = await WalletFacade.init({
      configuration: {
        networkId: NETWORK,
        indexerClientConnection: { indexerHttpUrl: indexerUrl, indexerWsUrl },
        provingServerUrl: new URL(flag("proof-server")),
        relayURL: wsUrl(nodeUrl),
        costParameters: { feeBlocksMargin: 100 },
        txHistoryStorage: new NoOpTransactionHistoryStorage(),
      },
      shielded: (config) =>
        restoreOr(
          snapshots?.shielded,
          (serialized) => ShieldedWallet(config).restore(serialized),
          () => ShieldedWallet(config).startWithSecretKeys(keys.shieldedSecretKeys),
        ),
      unshielded: (config) =>
        restoreOr(
          snapshots?.unshielded,
          (serialized) => UnshieldedWallet(config).restore(serialized),
          () =>
            UnshieldedWallet(config).startWithPublicKey(
              PublicKey.fromKeyStore(keys.unshieldedKeystore),
            ),
        ),
      dust: (config) =>
        restoreOr(
          snapshots?.dust,
          (serialized) => DustWallet(config).restore(serialized),
          () => DustWallet(config).startWithSecretKey(keys.dustSecretKey, dustParameters),
        ),
    });
    await facade.start(keys.shieldedSecretKeys, keys.dustSecretKey);
    const synced = await waitForCompleteSync(facade.state(), {
      timeoutMs: 30 * 60 * 1000,
      log,
    });
    log(`wallet synced in ${String(synced.elapsedMs)} ms: ${formatSyncProgress(synced.progress)}`);
    const secretKeys = {
      shieldedSecretKeys: keys.shieldedSecretKeys,
      dustSecretKey: keys.dustSecretKey,
    };
    const sign = (data) => keys.unshieldedKeystore.signDataAsync(data);
    return {
      facade,
      identity,
      secretKeys,
      sign,
      balancer: {
        balanceTx: async (tx, ttl) => {
          await facade.estimateTransactionFee(tx, keys.dustSecretKey, { ttl });
          const recipe = await facade.balanceUnboundTransaction(tx, secretKeys, { ttl });
          return await facade.finalizeRecipe(await facade.signRecipe(recipe, sign));
        },
      },
      submitter: { submitTx: (tx) => facade.submitTransaction(tx) },
      close: async () => {
        try {
          await facade.stop();
        } finally {
          keys.clear();
        }
      },
    };
  } catch (error) {
    keys.clear();
    throw error;
  }
};

const inclusionOf = (found) => ({
  hash: found.hash,
  status: found.status,
  segments: found.segments,
  identifiers: found.identifiers,
  blockHeight: found.block.height,
  blockHash: found.block.hash,
  blockTimestamp: new Date(found.block.timestampMs).toISOString(),
});

// ---------------------------------------------------------------------------------------
// rejections (no wallet; nothing is submitted)
// ---------------------------------------------------------------------------------------

const countingSource = () => {
  const calls = { latestBlock: 0, contractStateAt: 0 };
  return {
    calls,
    source: {
      latestBlock: async () => {
        calls.latestBlock += 1;
        return await source.latestBlock();
      },
      contractStateAt: async (address, hash) => {
        calls.contractStateAt += 1;
        return await source.contractStateAt(address, hash);
      },
    },
  };
};

const expectFailure = async (label, run) => {
  try {
    const value = await run();
    return { label, failed: false, value };
  } catch (error) {
    return {
      label,
      failed: true,
      errorName: error instanceof Error ? error.name : typeof error,
      stage: error instanceof PublicationCheckError ? error.stage : undefined,
      message: error instanceof Error ? error.message : String(error),
    };
  }
};

const runRejections = async () => {
  const emitter = String(flag("emitter")).toLowerCase();
  const consumer = String(flag("consumer")).toLowerCase();
  const profiles = contractProfiles();
  const emitterModule = await loadGeneratedModule(profiles.emitter);
  const consumerModule = await loadGeneratedModule(profiles.consumer);
  const coinPublicKey = String(flag("coin-public-key")).toLowerCase();
  const pattern = (length, seed) =>
    Uint8Array.from({ length }, (_, index) => (index * 37 + seed) % 256);
  const bindingOf = (module, whitelist, secret) => {
    const contract = new module.Contract(whitelist ? emitterWitnesses : messageOwnerWitnesses);
    return bindingFromContract(
      { impureCircuits: { emitPart: contract.impureCircuits.emitPart } },
      "emitPart",
      () => (whitelist ? { emitterSecret: secret } : { messageOwnerSecret: secret }),
    );
  };
  const config = (address) => ({ network: NETWORK, emitter: address, coinPublicKey });
  const cases = [];

  // 1. wrong emitter secret: execution fails before any proof input exists.
  {
    const counting = countingSource();
    const outcome = await expectFailure("wrong emitter secret", () =>
      buildPublicationTransaction(
        counting.source,
        bindingOf(emitterModule, true, new Uint8Array(randomBytes(32))),
        config(emitter),
        encodePublication(pattern(417, 11)),
      ),
    );
    cases.push({
      ...outcome,
      expectedStage: "execution (local circuit run, before proving)",
      stateReads: counting.calls,
      proverCalls: 0,
      walletCalls: 0,
      pass: outcome.failed && /not the emitter authority/u.test(outcome.message),
    });
  }
  // 2. consumer emitPart for an unregistered request ID (right owner secret).
  const ownerSecret = readWitnessSecret(flag("owner-secret-file"));
  try {
    const counting = countingSource();
    const outcome = await expectFailure("consumer: unregistered request ID", () =>
      buildPublicationTransaction(
        counting.source,
        bindingOf(consumerModule, false, ownerSecret),
        config(consumer),
        encodePublication(pattern(300, 5)),
      ),
    );
    cases.push({
      ...outcome,
      expectedStage: "execution (local circuit run, before proving)",
      stateReads: counting.calls,
      proverCalls: 0,
      walletCalls: 0,
      pass: outcome.failed,
    });
  } finally {
    ownerSecret.fill(0);
  }
  // 3. consumer emitPart for the registered M1 with a wrong owner secret.
  {
    const counting = countingSource();
    const outcome = await expectFailure("consumer: registered M1, wrong owner secret", () =>
      buildPublicationTransaction(
        counting.source,
        bindingOf(consumerModule, false, new Uint8Array(randomBytes(32))),
        config(consumer),
        encodePublication(pattern(417, 11)),
      ),
    );
    cases.push({
      ...outcome,
      expectedStage: "execution (local circuit run, before proving)",
      stateReads: counting.calls,
      proverCalls: 0,
      walletCalls: 0,
      pass: outcome.failed,
    });
  }
  // 4. a 9-part message under the default cap 8: refused before any provider call.
  {
    const counting = countingSource();
    const outcome = await expectFailure("9-part message, default cap 8", () =>
      buildPublicationTransaction(
        counting.source,
        bindingOf(emitterModule, true, new Uint8Array(randomBytes(32))),
        config(emitter),
        encodePublication(pattern(9 * 208, 11)),
      ),
    );
    cases.push({
      ...outcome,
      expectedStage: "construction (preflight, before any state read or provider call)",
      stateReads: counting.calls,
      proverCalls: 0,
      walletCalls: 0,
      pass:
        outcome.failed && counting.calls.latestBlock === 0 && counting.calls.contractStateAt === 0,
    });
  }
  // 5. tampered finalized records: refused before the submitter is called.
  const saved = JSON.parse(readFileSync(flag("m1-record"), "utf8"));
  const record = saved.record;
  const tamper = (hex, index) => {
    const bytes = hexToBytes(hex);
    bytes[index] ^= 0x01;
    return bytesToHex(bytes);
  };
  const submitterCalls = { count: 0 };
  const countingSubmitter = {
    submitTx: () => {
      submitterCalls.count += 1;
      return Promise.reject(new Error("must not be called"));
    },
  };
  const middle = Math.floor(record.transactionHex.length / 4);
  for (const [label, altered] of [
    [
      "finalized bytes: one byte flipped in the middle",
      { ...record, transactionHex: tamper(record.transactionHex, middle) },
    ],
    [
      "finalized bytes: one byte flipped in the last tail's data",
      {
        ...record,
        tailsHex: record.tailsHex.map((tail, index) =>
          index === record.tailsHex.length - 1 ? tamper(tail, 100) : tail,
        ),
      },
    ],
    ["record: intent hash altered", { ...record, intentHash: tamper(record.intentHash, 0) }],
  ]) {
    const before = submitterCalls.count;
    const outcome = await expectFailure(label, () => submitPublication(countingSubmitter, altered));
    cases.push({
      ...outcome,
      expectedStage: "before submission (saved-record re-check)",
      submitterCalls: submitterCalls.count - before,
      pass: outcome.failed && submitterCalls.count === before,
    });
  }
  // 6. the reader over M1's LIVE events: parts missing, and a part duplicated under
  //    another event identity.
  const m1Tx = String(flag("m1-tx")).toLowerCase();
  const live = await indexer.miscEvents(emitter, { transactionHash: m1Tx });
  const converted = publicEventsFromIndexer(live, {
    network: NETWORK,
    emitter,
    entryPoint: "emitPart",
  });
  const statusOf = (events) =>
    readPublications(events).results.map((result) => ({
      status: result.status,
      requestId: result.scope.requestIdHex ?? null,
      receivedParts: result.receivedParts,
      expectedParts: result.expectedParts ?? null,
      issues: result.issues,
    }));
  const all = statusOf(converted.events);
  const first = converted.events.slice(0, 2);
  const duplicated = [
    ...converted.events,
    { ...converted.events[0], eventId: `${converted.events[0].eventId}:copy` },
  ];
  const partial = statusOf(first);
  const dup = statusOf(duplicated);
  cases.push({
    label: "reader: all 3 live M1 events",
    liveEventIds: live.map((event) => event.id),
    results: all,
    pass: all.length === 1 && all[0].status === "complete",
  });
  cases.push({
    label: "reader: live M1 parts 1-2 only",
    results: partial,
    pass: partial.length === 1 && partial[0].status === "incomplete",
  });
  cases.push({
    label: "reader: live M1 with part 1 duplicated under another event identity",
    results: dup,
    pass: dup.length === 1 && dup[0].status === "rejected",
  });
  const result = {
    kind: "rejections",
    at: new Date().toISOString(),
    network: NETWORK,
    emitter,
    consumer,
    submittedAnything: false,
    cases,
    allPass: cases.every((item) => item.pass),
  };
  writeRecord(flag("out"), result);
  for (const item of cases) {
    log(
      `${item.pass ? "PASS" : "FAIL"} ${item.label}${item.stage ? ` [stage ${item.stage}]` : ""}${item.message ? `: ${item.message.slice(0, 160)}` : ""}`,
    );
  }
  return result.allPass ? 0 : 1;
};

// ---------------------------------------------------------------------------------------
// release (consumer, owner only)
// ---------------------------------------------------------------------------------------

const runRelease = async () => {
  const profile = contractProfiles().consumer;
  const generated = await loadGeneratedModule(profile);
  const address = String(flag("contract")).toLowerCase();
  const publication = encodePublication(messageFromHex("message-hex"));
  const requestId = bytesToHex(publication.requestId);
  const wallet = await openWallet();
  const secret = readWitnessSecret(flag("owner-secret-file"));
  try {
    const contract = new generated.Contract(messageOwnerWitnesses);
    const built = await buildCircuitCallTransaction(source, {
      network: NETWORK,
      address,
      circuit: "release",
      coinPublicKey: wallet.identity.coinPublicKey,
      privateState: { messageOwnerSecret: secret },
      execute: (context) => contract.impureCircuits.release(context, publication.requestId),
      ttlSeconds: 1200,
    });
    log(
      `built release for request ${requestId}, segment ${String(built.segment)}, block ${String(built.block.height)}`,
    );
    const check = callIntentCheck(built);
    const finalized = await finalizeTransaction(
      { prover: proverFor(profile), balancer: wallet.balancer },
      built.transaction,
      {
        network: NETWORK,
        purpose: "release",
        proofTimeoutMs: 900_000,
        ttl: built.ttl,
        ledgerParameters: built.ledgerParameters,
        block: built.block,
        check,
        costCheck: blockFullnessCheck(1),
      },
    );
    let record = {
      kind: "release",
      network: NETWORK,
      address,
      circuit: "release",
      requestId,
      finalized,
    };
    writeRecord(flag("out"), record);
    log(`finalized ${String(finalized.transactionHex.length / 2)} bytes; record written`);
    const submittedId = await submitSavedTransaction(wallet.submitter, finalized, check);
    record = { ...record, submittedId };
    writeRecord(flag("out"), record);
    log(`submitted ${submittedId}`);
    const found = await waitForTransaction(
      indexer,
      { identifiers: finalized.identifiers },
      {
        timeoutMs: Math.max(60_000, built.ttl.getTime() - Date.now() + 60_000),
      },
    );
    if (found === undefined) throw new Error("the release was not seen before its TTL");
    const { state } = await indexer.contractState(address);
    const registry = generated.ledger(
      RuntimeContractState.deserialize(hexToBytes(state.stateHex)).data,
    ).messageOwner;
    const stillRegistered = registry.member(publication.requestId);
    record = {
      ...record,
      inclusion: inclusionOf(found),
      registryHoldsRequestAfter: stillRegistered,
    };
    writeRecord(flag("out"), record);
    log(
      `included ${found.hash} at block ${String(found.block.height)}, status ${String(found.status)}; registry still holds the request: ${String(stillRegistered)}`,
    );
    return found.status === "SUCCESS" && !stillRegistered ? 0 : 1;
  } finally {
    secret.fill(0);
    await wallet.close();
  }
};

// ---------------------------------------------------------------------------------------
// merge-sealed (Q26)
// ---------------------------------------------------------------------------------------

const runMergeSealed = async () => {
  const profile = contractProfiles().emitter;
  const generated = await loadGeneratedModule(profile);
  const emitter = String(flag("contract")).toLowerCase();
  const dryRun = flags.get("dry-run") === true;
  const messages = { a: messageFromHex("message-a-hex"), b: messageFromHex("message-b-hex") };
  const wallet = await openWallet();
  const secret = readWitnessSecret(flag("emitter-secret-file"));
  const checks = [];
  const pass = (name, ok, detail) => {
    checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
    log(`${ok ? "OK  " : "FAIL"} ${name}${detail === undefined ? "" : ` (${detail})`}`);
    if (!ok) throw new Error(`offline check failed: ${name}`);
  };
  // The facade's validation runs `wellFormed` against a ledger state WITHOUT contracts, so
  // it refuses any contract call ("call to non-existant contract"); advisory only.
  const advisories = [];
  const advisory = async (name, run) => {
    try {
      await run();
      advisories.push({ name, ok: true });
      log(`ADVISORY OK   ${name}`);
    } catch (error) {
      advisories.push({ name, ok: false, detail: errorText(error) });
      log(`ADVISORY FAIL ${name} (${errorText(error)})`);
    }
  };
  let record = { kind: "merge-sealed", network: NETWORK, emitter, dryRun, checks, advisories };
  try {
    const contract = new generated.Contract(emitterWitnesses);
    const binding = bindingFromContract(
      { impureCircuits: { emitPart: contract.impureCircuits.emitPart } },
      "emitPart",
      () => ({ emitterSecret: secret }),
    );
    const config = {
      network: NETWORK,
      emitter,
      coinPublicKey: wallet.identity.coinPublicKey,
      maxParts: 8,
      ttlSeconds: 1200,
    };
    const prover = proverFor(profile);
    const params = (await indexer.latestBlock()).ledgerParametersHex;
    const parameters = ledgerParametersFromHex(params);
    const timings = {};
    const started = Date.now();
    const builtA = await buildPublicationTransaction(
      source,
      binding,
      config,
      encodePublication(messages.a),
    );
    let builtB = await buildPublicationTransaction(
      source,
      binding,
      config,
      encodePublication(messages.b),
    );
    for (
      let attempt = 0;
      builtB.expected.segment === builtA.expected.segment && attempt < 8;
      attempt += 1
    ) {
      builtB = await buildPublicationTransaction(
        source,
        binding,
        config,
        encodePublication(messages.b),
      );
    }
    timings.buildMs = Date.now() - started;
    pass(
      "the two publication intents sit on different segments",
      builtA.expected.segment !== builtB.expected.segment,
      `${String(builtA.expected.segment)} / ${String(builtB.expected.segment)}`,
    );
    const unprovenHash = {
      a: intentHash(builtA.transaction, builtA.expected.segment),
      b: intentHash(builtB.transaction, builtB.expected.segment),
    };
    const proveStarted = Date.now();
    const [provenA, provenB] = await Promise.all([
      prover.proveTx(builtA.transaction, { timeout: 900_000 }),
      prover.proveTx(builtB.transaction, { timeout: 900_000 }),
    ]);
    timings.proveMs = Date.now() - proveStarted;
    assertPublicationIntent(provenA, builtA.expected, "after proving", builtA.frozenTranscripts);
    assertPublicationIntent(provenB, builtB.expected, "after proving", builtB.frozenTranscripts);
    // Seal = bind, WITHOUT any fee payment.
    const sealedA = provenA.bind();
    const sealedB = provenB.bind();
    assertPublicationIntent(sealedA, builtA.expected, "after sealing", builtA.frozenTranscripts);
    assertPublicationIntent(sealedB, builtB.expected, "after sealing", builtB.frozenTranscripts);
    const describe = (sealed, built, message) => ({
      messageHex: bytesToHex(message),
      messageBytes: message.length,
      requestIdHex: bytesToHex(built.expected.requestId),
      parts: built.expected.tails.length,
      segment: built.expected.segment,
      transactionHash: sealed.transactionHash(),
      identifiers: sealed.identifiers(),
      intentHash: intentHash(sealed, built.expected.segment),
      ttl: built.ttl.toISOString(),
      pinnedBlock: built.block,
      transactionHex: bytesToHex(sealed.serialize()),
      segments: segmentsOf(sealed),
    });
    const a = describe(sealedA, builtA, messages.a);
    const b = describe(sealedB, builtB, messages.b);
    pass("intent hash stable from unproven to sealed (A)", unprovenHash.a === a.intentHash);
    pass("intent hash stable from unproven to sealed (B)", unprovenHash.b === b.intentHash);
    pass(
      "sealed A carries only its publication intent (no fee intent)",
      a.segments.length === 1,
      a.segments.join(","),
    );
    pass(
      "sealed B carries only its publication intent (no fee intent)",
      b.segments.length === 1,
      b.segments.join(","),
    );
    const intentA = intentBytes(sealedA, a.segment);
    const intentB = intentBytes(sealedB, b.segment);
    record = { ...record, sealedA: a, sealedB: b };
    writeRecord(flag("out"), record);

    // Merge the two sealed transactions.
    const merged = sealedA.merge(sealedB);
    const mergedInfo = {
      transactionHash: merged.transactionHash(),
      identifiers: merged.identifiers(),
      segments: segmentsOf(merged),
      transactionHex: bytesToHex(merged.serialize()),
    };
    pass(
      "merged transaction holds exactly the two publication segments",
      mergedInfo.segments.length === 2 &&
        mergedInfo.segments.includes(a.segment) &&
        mergedInfo.segments.includes(b.segment),
      mergedInfo.segments.join(","),
    );
    pass(
      "A's intent is byte-identical after the merge",
      intentBytes(merged, a.segment) === intentA,
    );
    pass(
      "B's intent is byte-identical after the merge",
      intentBytes(merged, b.segment) === intentB,
    );
    pass(
      "merged identifiers include A's and B's",
      [...a.identifiers, ...b.identifiers].every((id) => mergedInfo.identifiers.includes(id)),
    );
    // The composer's publisher-side guard also requires that NO other intent calls the
    // emitter's entry point; merging two publications of one emitter violates exactly that
    // rule by construction (Q27). Record its answer; each intent itself is byte-identical
    // to its sealed original, which passed the guard after sealing.
    const guardAnswer = (tx, stage) =>
      [builtA, builtB].map((built) => {
        try {
          assertPublicationIntent(tx, built.expected, stage);
          return { segment: built.expected.segment, refused: false };
        } catch (error) {
          return { segment: built.expected.segment, refused: true, reason: errorText(error) };
        }
      });
    const guardAfterMerge = guardAnswer(merged, "after merge");
    pass(
      "composer guard on the merged transaction refuses only for the other same-emitter intent (by design, Q27)",
      guardAfterMerge.every(
        (answer) => answer.refused && /also calls the emitter's emitPart/u.test(answer.reason),
      ),
      guardAfterMerge.map((answer) => answer.reason ?? "accepted").join(" | "),
    );
    await advisory("facade validateTransaction(merged, no balancing)", () =>
      wallet.facade.validateTransaction(merged, {
        flags: { enforceBalancing: false, verifySignatures: true, enforceLimits: false },
      }),
    );
    record = { ...record, merged: { ...mergedInfo, guard: guardAfterMerge } };
    writeRecord(flag("out"), record);

    // Balance the merged SEALED transaction once: the facade adds a separate fee intent.
    const ttl = new Date(Math.min(builtA.ttl.getTime(), builtB.ttl.getTime()));
    const balanceStarted = Date.now();
    const fee = await wallet.facade.estimateTransactionFee(
      merged,
      wallet.secretKeys.dustSecretKey,
      { ttl },
    );
    const recipe = await wallet.facade.balanceFinalizedTransaction(merged, wallet.secretKeys, {
      ttl,
    });
    pass(
      "balanceFinalizedTransaction returned a FINALIZED_TRANSACTION recipe",
      recipe.type === "FINALIZED_TRANSACTION",
      recipe.type,
    );
    pass(
      "the recipe's original transaction is the merged one",
      recipe.originalTransaction.transactionHash() === mergedInfo.transactionHash,
    );
    const signed = await wallet.facade.signRecipe(recipe, wallet.sign);
    const final = await wallet.facade.finalizeRecipe(signed);
    timings.balanceMs = Date.now() - balanceStarted;
    const bytes = final.serialize();
    const roundTrip = ledger.Transaction.deserialize("signature", "proof", "binding", bytes);
    const finalInfo = {
      transactionHash: roundTrip.transactionHash(),
      identifiers: roundTrip.identifiers(),
      segments: segmentsOf(roundTrip),
      transactionHex: bytesToHex(bytes),
      bytes: bytes.length,
      estimatedFeeSpeck: fee,
      normalizedCost: { ...parameters.normalizeFullness(roundTrip.cost(parameters, true)) },
    };
    pass(
      "final transaction = A + B + one fee intent",
      finalInfo.segments.length === 3,
      finalInfo.segments.join(","),
    );
    pass(
      "A's intent is byte-identical in the final transaction",
      intentBytes(roundTrip, a.segment) === intentA,
    );
    pass(
      "B's intent is byte-identical in the final transaction",
      intentBytes(roundTrip, b.segment) === intentB,
    );
    pass(
      "final identifiers include A's and B's",
      [...a.identifiers, ...b.identifiers].every((id) => finalInfo.identifiers.includes(id)),
    );
    const guardAfterBalancing = guardAnswer(roundTrip, "after balancing");
    pass(
      "composer guard after balancing: same answer (only the other same-emitter intent is flagged)",
      guardAfterBalancing.every(
        (answer) => answer.refused && /also calls the emitter's emitPart/u.test(answer.reason),
      ),
    );
    blockFullnessCheck(1)(roundTrip, parameters, "after balancing");
    pass(
      "the final cost fits one block under the live parameters",
      true,
      JSON.stringify(finalInfo.normalizedCost),
    );
    await advisory("facade validateTransaction(final, strict)", () =>
      wallet.facade.validateTransaction(final, {
        flags: { enforceBalancing: true, verifySignatures: true, enforceLimits: true },
        ...(recipe.blockData === undefined ? {} : { blockData: recipe.blockData }),
      }),
    );
    const offline = verifyPublicationTransaction(roundTrip, {
      emitter,
      entryPoint: "emitPart",
      network: NETWORK,
      status: "SUCCESS",
      transactionHash: finalInfo.transactionHash,
    });
    const complete = offline.accepted.filter((result) => result.status === "complete");
    pass(
      "offline Level 1/2 over the final bytes: both publications complete, guaranteed-only",
      offline.issues.length === 0 && complete.length === 2,
      `${String(complete.length)} complete, issues: ${offline.issues.join("; ")}`,
    );
    record = { ...record, final: { ...finalInfo, guard: guardAfterBalancing }, timings };
    writeRecord(flag("out"), record);
    if (dryRun) {
      log("dry run: every offline check passed; nothing submitted");
      return 0;
    }

    // Submit once.
    const submitStarted = Date.now();
    let submittedId;
    try {
      submittedId = await wallet.facade.submitTransaction(roundTrip);
    } catch (error) {
      record = {
        ...record,
        submission: {
          refused: true,
          at: new Date().toISOString(),
          error: errorText(error),
          stage: "admission (submission refused, nothing included)",
        },
      };
      writeRecord(flag("out"), record);
      log(`submission refused: ${errorText(error)}`);
      return 1;
    }
    timings.submitMs = Date.now() - submitStarted;
    record = {
      ...record,
      submission: { refused: false, submittedId, at: new Date().toISOString() },
    };
    writeRecord(flag("out"), record);
    log(`submitted ${submittedId}`);
    const found = await waitForTransaction(
      indexer,
      { identifiers: finalInfo.identifiers },
      {
        timeoutMs: Math.max(60_000, ttl.getTime() - Date.now() + 60_000),
      },
    );
    if (found === undefined) {
      log("not seen before the TTL: not included");
      record = { ...record, inclusion: null };
      writeRecord(flag("out"), record);
      return 1;
    }
    const included = deserializeTransaction(hexToBytes(found.rawHex));
    const recordOf = (info, built) => ({
      network: NETWORK,
      emitter,
      entryPoint: "emitPart",
      segment: info.segment,
      requestIdHex: info.requestIdHex,
      tailsHex: built.expected.tails.map(bytesToHex),
      transactionHex: info.transactionHex,
      transactionHash: info.transactionHash,
      identifiers: info.identifiers,
      intentHash: info.intentHash,
      ttl: info.ttl,
      blockHash: info.pinnedBlock.hash,
      blockHeight: info.pinnedBlock.height,
    });
    // `locatePublication` reuses the guard, so it reports "not contained" here (Q27);
    // containment is checked directly: identifiers present, intent bytes unchanged.
    const locateA = locatePublication(included, recordOf(a, builtA));
    const locateB = locatePublication(included, recordOf(b, builtB));
    const containedOf = (info, bytes) => ({
      identifiersPresent: info.identifiers.every((id) => included.identifiers().includes(id)),
      intentUnchanged: intentBytes(included, info.segment) === bytes,
      intentHash: intentHash(included, info.segment),
    });
    const contained = { a: containedOf(a, intentA), b: containedOf(b, intentB) };
    record = {
      ...record,
      inclusion: {
        ...inclusionOf(found),
        rawEqualsSubmitted: found.rawHex === finalInfo.transactionHex,
      },
      contained,
      locatePublication: { a: locateA, b: locateB },
    };
    writeRecord(flag("out"), record);
    log(
      `included ${found.hash} at block ${String(found.block.height)}, status ${String(found.status)}; A ${JSON.stringify(contained.a)}; B ${JSON.stringify(contained.b)}`,
    );
    const inside = (item) => item.identifiersPresent && item.intentUnchanged;
    return found.status === "SUCCESS" && inside(contained.a) && inside(contained.b) ? 0 : 1;
  } catch (error) {
    record = { ...record, error: errorText(error) };
    writeRecord(flag("out"), record);
    throw error;
  } finally {
    secret.fill(0);
    await wallet.close();
  }
};

// ---------------------------------------------------------------------------------------
// replay
// ---------------------------------------------------------------------------------------

const runReplay = async () => {
  const saved = JSON.parse(readFileSync(flag("record"), "utf8"));
  const publication = saved.record;
  const [already] = await indexer.transactionsByHash(publication.transactionHash);
  const wallet = await openWallet();
  let record = {
    kind: "replay",
    network: NETWORK,
    replayedTransactionHash: publication.transactionHash,
    identifiers: publication.identifiers,
    ttl: publication.ttl,
    alreadyIncluded: already === undefined ? null : inclusionOf(already),
    attemptedAt: new Date().toISOString(),
  };
  try {
    let outcome;
    try {
      const id = await submitPublication(wallet.submitter, publication);
      outcome = { refused: false, submittedId: id };
    } catch (error) {
      outcome = {
        refused: true,
        errorName: error instanceof Error ? error.name : typeof error,
        stage:
          error instanceof PublicationCheckError ? error.stage : "submission (node/relay answer)",
        error: errorText(error),
      };
    }
    const after = await indexer.transactionsByHash(publication.transactionHash);
    record = {
      ...record,
      outcome,
      indexerCopiesAfter: after.length,
      answeredAt: new Date().toISOString(),
    };
    writeRecord(flag("out"), record);
    log(
      `replay ${outcome.refused ? "REFUSED" : "ACCEPTED"}: ${outcome.error ?? outcome.submittedId}`,
    );
    return outcome.refused ? 0 : 1;
  } finally {
    await wallet.close();
  }
};

const commands = {
  rejections: runRejections,
  release: runRelease,
  "merge-sealed": runMergeSealed,
  replay: runReplay,
};
const run = commands[command];
if (run === undefined) {
  console.error(`usage: chain-tool.mjs ${Object.keys(commands).join("|")} ...`);
  process.exit(2);
}
let status = 1;
try {
  status = await run();
} catch (error) {
  log(`failed: ${errorText(error)}`);
}
// Flush before exiting (a wallet keeps the event loop alive).
await new Promise((resolve) => process.stdout.write("", resolve));
process.exit(status);
