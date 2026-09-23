/**
 * Deployment and single-call transactions: verifier keys installed for every provable
 * circuit, a one-key maintenance authority, the address known before submission,
 * the deploy-intent check; a registration (`register3` of the registry test contract)
 * as one guaranteed call that is applied and changes the registry; the call-intent
 * check; and finalize/submit with the same discipline as publications.
 */
import {
  ContractState as RuntimeContractState,
  createConstructorContext,
} from "@midnight-ntwrk/compact-runtime";
import * as ledger from "@midnightntwrk/ledger-v9";
import { beforeAll, describe, expect, it } from "vitest";

import { encodePublication } from "../src/codec/index.js";
import { messageOwnerOf, type MessageOwnerPrivateState } from "../src/contract/index.js";
import {
  buildCircuitCallTransaction,
  buildDeployTransaction,
  callIntentCheck,
  deployIntentCheck,
  finalizeTransaction,
  PublicationCheckError,
  submitSavedTransaction,
} from "../src/transaction/index.js";
import { filled32, patternMessage, toHex } from "./helpers/bytes.js";
import {
  COIN_PUBLIC_KEY,
  EMITTER_VERIFIER_KEY,
  emitterInitialState,
  registryBinding,
  registryContract,
} from "./helpers/generated.js";
import { LocalChain, NETWORK } from "./helpers/ledger.js";
import { standInBalancer, standInProver } from "./helpers/offline-services.js";

const maintenance = ledger.signatureVerifyingKey(ledger.sampleSigningKey());
const ttl = () => new Date(Date.now() + 10 * 60 * 1000);

describe("deployment transactions", () => {
  it("installs every verifier key and the maintenance authority, and applies", async () => {
    const chain = new LocalChain();
    const built = buildDeployTransaction({
      network: NETWORK,
      initialState: await emitterInitialState(filled32(0x11)),
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
    const initialState = await emitterInitialState(filled32(0x12));
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
        initialState: await emitterInitialState(filled32(byte)),
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

describe("single-call transactions (registration)", () => {
  const OWNER = filled32(0x31);
  let chain: LocalChain;
  let registry: string;

  beforeAll(async () => {
    chain = new LocalChain();
    const initial = await registryContract().initialState(
      createConstructorContext<MessageOwnerPrivateState>(
        { messageOwnerSecret: OWNER },
        COIN_PUBLIC_KEY,
      ),
    );
    const circuits = ledger.ContractState.deserialize(initial.currentContractState.serialize())
      .operations()
      .map((name) => (typeof name === "string" ? name : new TextDecoder().decode(name)));
    // Offline only: any non-empty key bytes install; proofs are erased and never checked.
    const built = buildDeployTransaction({
      network: NETWORK,
      initialState: initial.currentContractState,
      verifierKeys: Object.fromEntries(circuits.map((name) => [name, EMITTER_VERIFIER_KEY])),
      maintenanceCommittee: [maintenance],
      ttl: new Date(chain.time.getTime() + 600_000),
    });
    expect(chain.apply(built.transaction.eraseProofs()).type).toBe("success");
    registry = built.address;
  });

  const plan = (message: Uint8Array, secret = OWNER) => {
    const publication = encodePublication(message);
    return {
      publication,
      plan: {
        network: NETWORK,
        address: registry,
        circuit: "register3",
        coinPublicKey: COIN_PUBLIC_KEY,
        privateState: { messageOwnerSecret: secret },
        execute: (
          context: Parameters<
            ReturnType<typeof registryContract>["impureCircuits"]["register3"]
          >[0],
        ) =>
          registryContract().impureCircuits.register3(
            context,
            publication.requestId,
            publication.parts.map((part) => part.tail),
          ),
      },
    };
  };

  it("builds one guaranteed call, applies it, and the registry holds the owner commitment", async () => {
    const { publication, plan: callPlan } = plan(patternMessage(417));
    const built = await buildCircuitCallTransaction(chain.source(), callPlan);
    callIntentCheck(built)(built.transaction, "before proving");
    expect(built.segment).toBeGreaterThan(0);
    const result = chain.apply(built.transaction.eraseProofs());
    expect(result.type, String(result.error)).toBe("success");
    const state = RuntimeContractState.deserialize(
      chain.state.index(registry)?.serialize() ?? new Uint8Array(),
    );
    const ledgerView = registryBinding.ledger(state.data);
    expect(ledgerView.messageOwner.member(publication.requestId)).toBe(true);
    expect(toHex(ledgerView.messageOwner.lookup(publication.requestId))).toBe(
      toHex(messageOwnerOf(OWNER)),
    );
  });

  it("a second registration of the same id fails while executing, before any transaction exists", async () => {
    await expect(
      buildCircuitCallTransaction(chain.source(), plan(patternMessage(417)).plan),
    ).rejects.toThrow(/already registered/);
  });

  it("the call-intent check rejects another segment and a transaction with extra calls to the circuit", async () => {
    const built = await buildCircuitCallTransaction(chain.source(), plan(patternMessage(418)).plan);
    expect(() =>
      callIntentCheck({ ...built, segment: (built.segment % 60000) + 1 })(built.transaction, "x"),
    ).toThrow(/no intent at segment/);
    const other = await buildCircuitCallTransaction(chain.source(), plan(patternMessage(419)).plan);
    const merged = built.transaction.merge(other.transaction);
    expect(() => callIntentCheck(built)(merged, "after balancing")).toThrow(/also calls register3/);
  });

  it("finalizes with the intent check at every stage and submits exactly the saved bytes", async () => {
    const built = await buildCircuitCallTransaction(chain.source(), plan(patternMessage(420)).plan);
    const check = callIntentCheck(built);
    const record = await finalizeTransaction(
      { prover: standInProver, balancer: standInBalancer },
      built.transaction,
      {
        network: NETWORK,
        purpose: "register3",
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
      PublicationCheckError,
    );
    expect(submitted).toHaveLength(1);
  });
});
