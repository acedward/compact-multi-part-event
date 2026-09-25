/**
 * deploy-tools' deployment and single-call transactions: verifier keys installed for
 * every provable circuit, a one-key maintenance authority, the address known before
 * submission, the deploy-intent check; the notice board's state-changing `pin` as one
 * guaranteed call that is applied and changes the board; the call-intent check; and
 * finalize/submit (the publisher's generic path) with the same discipline as packages.
 */
import {
  ContractState as RuntimeContractState,
  createConstructorContext,
} from "@midnight-ntwrk/compact-runtime";
import * as ledger from "@midnightntwrk/ledger-v9";
import { beforeAll, describe, expect, it } from "vitest";

import { emitterAuthorityOf } from "../contract-examples/whitelist/whitelist.js";
import { buildCircuitCallTransaction, callIntentCheck } from "../deploy-tools/call.js";
import { buildDeployTransaction, deployIntentCheck } from "../deploy-tools/deploy.js";
import {
  finalizeTransaction,
  PackageCheckError,
  type PublicationBalancer,
  type PublicationProver,
  submitSavedTransaction,
} from "../src/publisher/index.js";
import { filled32, toHex } from "./helpers/bytes.js";
import {
  BOARD_VERIFIER_KEYS,
  COIN_PUBLIC_KEY,
  EMITTER_VERIFIER_KEY,
  emitterInitialState,
  noticeBoardModule,
} from "./helpers/generated.js";
import { LocalChain, NETWORK } from "./helpers/ledger.js";

type Proven = ledger.Transaction<ledger.SignatureEnabled, ledger.Proof, ledger.PreBinding>;
type BoardState = { emitterSecret: Uint8Array };

const maintenance = ledger.signatureVerifyingKey(ledger.sampleSigningKey());
const ttl = () => new Date(Date.now() + 10 * 60 * 1000);
const standInProver: PublicationProver = {
  proveTx: (tx) => Promise.resolve(tx as unknown as Proven),
};
const standInBalancer: PublicationBalancer = {
  balanceTx: (tx) =>
    Promise.resolve(
      (
        tx as unknown as ledger.UnprovenTransaction
      ).bind() as unknown as ledger.FinalizedTransaction,
    ),
};
const boardContract = () =>
  new noticeBoardModule.Contract<BoardState>({
    emitterSecret: ({ privateState }) => [privateState, privateState.emitterSecret],
  });

describe("deployment transactions", () => {
  it("installs every verifier key and the maintenance authority, and applies", async () => {
    const chain = new LocalChain();
    const built = buildDeployTransaction({
      network: NETWORK,
      initialState: await emitterInitialState(emitterAuthorityOf(filled32(0x11))),
      verifierKeys: { emitPart: EMITTER_VERIFIER_KEY },
      maintenanceCommittee: [maintenance],
      ttl: new Date(chain.time.getTime() + 600_000),
    });
    expect(built.address).toMatch(/^[0-9a-f]{64}$/);
    expect(built.operations).toEqual(["emitPart"]);
    deployIntentCheck(built)(built.transaction, "before proving");
    const result = chain.apply(built.transaction.eraseProofs());
    expect(result.type).toBe("success");
    const deployed = chain.state.index(built.address);
    expect(deployed?.operation("emitPart")?.verifierKey).toEqual(EMITTER_VERIFIER_KEY);
    expect(deployed?.maintenanceAuthority.committee).toEqual([maintenance]);
    expect(deployed?.maintenanceAuthority.threshold).toBe(1);
  });

  it("refuses a missing or unknown verifier key and an empty committee", async () => {
    const initialState = await emitterInitialState(emitterAuthorityOf(filled32(0x12)));
    const base = {
      network: NETWORK,
      initialState,
      maintenanceCommittee: [maintenance],
      ttl: ttl(),
    };
    expect(() => buildDeployTransaction({ ...base, verifierKeys: {} })).toThrow(
      /no verifier key for circuit 'emitPart'/,
    );
    expect(() =>
      buildDeployTransaction({
        ...base,
        verifierKeys: { emitPart: EMITTER_VERIFIER_KEY, other: EMITTER_VERIFIER_KEY },
      }),
    ).toThrow(/unknown circuit 'other'/);
    expect(() =>
      buildDeployTransaction({
        ...base,
        verifierKeys: { emitPart: EMITTER_VERIFIER_KEY },
        maintenanceCommittee: [],
      }),
    ).toThrow(/at least one verifying key/);
  });

  it("the deploy-intent check rejects another deployment and a transaction without it", async () => {
    const make = async (byte: number) =>
      buildDeployTransaction({
        network: NETWORK,
        initialState: await emitterInitialState(emitterAuthorityOf(filled32(byte))),
        verifierKeys: { emitPart: EMITTER_VERIFIER_KEY },
        maintenanceCommittee: [maintenance],
        ttl: ttl(),
      });
    const one = await make(0x13);
    const two = await make(0x14);
    expect(() => deployIntentCheck(one)(two.transaction, "after balancing")).toThrow(
      /^after balancing: an intent deploys another contract/,
    );
    expect(() =>
      deployIntentCheck(one)(ledger.Transaction.fromParts(NETWORK), "after proving"),
    ).toThrow(/expected one deployment/);
  });
});

describe("single-call transactions (the notice board's pin)", () => {
  const OWNER = filled32(0x31);
  let chain: LocalChain;
  let boardAddress: string;

  beforeAll(async () => {
    chain = new LocalChain();
    const initial = await boardContract().initialState(
      createConstructorContext<BoardState>({ emitterSecret: OWNER }, COIN_PUBLIC_KEY),
      emitterAuthorityOf(OWNER),
    );
    const built = buildDeployTransaction({
      network: NETWORK,
      initialState: initial.currentContractState,
      verifierKeys: BOARD_VERIFIER_KEYS,
      maintenanceCommittee: [maintenance],
      ttl: new Date(chain.time.getTime() + 600_000),
    });
    expect(built.operations).toEqual(["emitPart", "pin"]);
    expect(chain.apply(built.transaction.eraseProofs()).type).toBe("success");
    boardAddress = built.address;
  });

  const plan = (digest: Uint8Array, secret = OWNER) => ({
    network: NETWORK,
    address: boardAddress,
    circuit: "pin",
    coinPublicKey: COIN_PUBLIC_KEY,
    privateState: { emitterSecret: secret },
    execute: (context: Parameters<ReturnType<typeof boardContract>["impureCircuits"]["pin"]>[0]) =>
      boardContract().impureCircuits.pin(context, digest),
  });

  it("builds one guaranteed call, applies it, and the board's state changes", async () => {
    const digest = filled32(0x51);
    const built = await buildCircuitCallTransaction(chain.source(), plan(digest));
    callIntentCheck(built)(built.transaction, "before proving");
    expect(built.segment).toBeGreaterThan(0);
    const result = chain.apply(built.transaction.eraseProofs());
    expect(result.type, String(result.error)).toBe("success");
    const view = noticeBoardModule.ledger(
      RuntimeContractState.deserialize(
        chain.state.index(boardAddress)?.serialize() ?? new Uint8Array(),
      ).data,
    );
    expect(view.pinnedCount).toBe(1n);
    expect(toHex(view.pinnedDigest)).toBe(toHex(digest));
  });

  it("a caller without the secret fails while executing, before any transaction exists", async () => {
    await expect(
      buildCircuitCallTransaction(chain.source(), plan(filled32(0x52), filled32(0x99))),
    ).rejects.toThrow(/caller is not the emitter authority/);
  });

  it("the call-intent check rejects another segment and a transaction with extra calls to the circuit", async () => {
    const built = await buildCircuitCallTransaction(chain.source(), plan(filled32(0x53)));
    expect(() =>
      callIntentCheck({ ...built, segment: (built.segment % 60000) + 1 })(built.transaction, "x"),
    ).toThrow(/no intent at segment/);
    const other = await buildCircuitCallTransaction(chain.source(), plan(filled32(0x54)));
    if (other.segment === built.segment) return;
    const merged = built.transaction.merge(other.transaction);
    expect(() => callIntentCheck(built)(merged, "after balancing")).toThrow(/also calls pin/);
  });

  it("finalizes with the intent check at every stage and submits exactly the saved bytes", async () => {
    const built = await buildCircuitCallTransaction(chain.source(), plan(filled32(0x55)));
    const check = callIntentCheck(built);
    const record = await finalizeTransaction(
      { prover: standInProver, balancer: standInBalancer },
      built.transaction,
      {
        network: NETWORK,
        purpose: "pin",
        proofTimeoutMs: 1000,
        ttl: built.ttl,
        ledgerParameters: built.ledgerParameters,
        block: built.block,
        check,
        requireProofs: false,
      },
    );
    expect(record.identifiers.length).toBeGreaterThan(0);
    const submitted: ledger.FinalizedTransaction[] = [];
    const submitter = {
      submitTx: (tx: ledger.FinalizedTransaction) => {
        submitted.push(tx);
        return Promise.resolve("id");
      },
    };
    await submitSavedTransaction(submitter, record, check, { requireProofs: false });
    expect(toHex(submitted[0]?.serialize() ?? new Uint8Array())).toBe(record.transactionHex);
    await expect(
      submitSavedTransaction(
        submitter,
        { ...record, identifiers: record.identifiers.slice(1) },
        check,
        {
          requireProofs: false,
        },
      ),
    ).rejects.toThrow(/recorded identifiers/);
    await expect(submitSavedTransaction(submitter, record, check)).rejects.toThrow(
      PackageCheckError,
    );
    expect(submitted).toHaveLength(1);
  });
});
