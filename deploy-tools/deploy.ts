/**
 * Deployment transactions: the constructor's initial state with the verifier keys
 * installed for every provable circuit and a maintenance authority, in one
 * `ContractDeploy` action.
 *
 * The maintenance authority outranks any access control in the contract: its holder
 * can remove every circuit and install new ones (for example an `emitPart` without the
 * whitelist check). Following the SDK's usual deployment, the authority is one
 * signing key held by the deployer (threshold 1). Its verifying key is public
 * evidence; the signing key belongs in a protected file.
 *
 * The contract address is known before submission, so it can be recorded before the
 * transaction is sent (a lost address cannot be recovered afterwards).
 *
 * @module
 */
import { createHash } from "node:crypto";

import * as ledger from "@midnightntwrk/ledger-v9";

import type { SerializableContractState } from "../src/publisher/compose.js";
import { PackageCheckError } from "../src/publisher/guard.js";
import { bytesEqual } from "../src/reader/bytes.js";
import type { AnyTransaction } from "../src/reader/transaction.js";

/** What to deploy. */
export interface DeployPlan {
  readonly network: string;
  /** Initial state from the generated constructor (`Contract.initialState(...)`). */
  readonly initialState: SerializableContractState;
  /** Verifier key per provable circuit; every operation of the state needs one. */
  readonly verifierKeys: Readonly<Record<string, Uint8Array>>;
  /** Maintenance committee (verifying keys) and threshold (default 1). */
  readonly maintenanceCommittee: readonly ledger.SignatureVerifyingKey[];
  readonly maintenanceThreshold?: number;
  /** Intent TTL. */
  readonly ttl: Date;
}

/** A deployment ready to be proven and balanced. */
export interface BuiltDeploy {
  readonly transaction: ledger.UnprovenTransaction;
  /** Address the contract will have. */
  readonly address: string;
  /** Serialized state being deployed (verifier keys and authority installed). */
  readonly stateBytes: Uint8Array;
  readonly operations: readonly string[];
  /** SHA-256 of each installed verifier key, by entry point. */
  readonly verifierKeyHashes: Readonly<Record<string, string>>;
  readonly ttl: Date;
}

const entryPointText = (entryPoint: string | Uint8Array): string =>
  typeof entryPoint === "string" ? entryPoint : new TextDecoder().decode(entryPoint);

/**
 * Build the unproven deployment transaction.
 *
 * @throws {RangeError} If an operation lacks a verifier key, a key names no operation,
 * or the committee is empty.
 */
export const buildDeployTransaction = (plan: DeployPlan): BuiltDeploy => {
  if (plan.maintenanceCommittee.length === 0) {
    throw new RangeError("the maintenance committee needs at least one verifying key");
  }
  const threshold = plan.maintenanceThreshold ?? 1;
  if (
    !Number.isSafeInteger(threshold) ||
    threshold < 1 ||
    threshold > plan.maintenanceCommittee.length
  ) {
    throw new RangeError("maintenance threshold must be 1..committee size");
  }
  const state = ledger.ContractState.deserialize(plan.initialState.serialize());
  const operations = state.operations().map(entryPointText).sort();
  const keyNames = Object.keys(plan.verifierKeys).sort();
  for (const name of keyNames) {
    if (!operations.includes(name))
      throw new RangeError(`verifier key for unknown circuit '${name}'`);
  }
  const verifierKeyHashes: Record<string, string> = {};
  for (const name of operations) {
    const key = plan.verifierKeys[name];
    if (key === undefined || key.byteLength === 0) {
      throw new RangeError(`no verifier key for circuit '${name}'`);
    }
    const operation = state.operation(name);
    if (operation === undefined) throw new RangeError(`no operation '${name}'`);
    operation.verifierKey = key;
    state.setOperation(name, operation);
    verifierKeyHashes[name] = createHash("sha256").update(key).digest("hex");
  }
  state.maintenanceAuthority = new ledger.ContractMaintenanceAuthority(
    [...plan.maintenanceCommittee],
    threshold,
    0n,
  );
  const deploy = new ledger.ContractDeploy(state);
  const transaction = ledger.Transaction.fromParts(
    plan.network,
    undefined,
    undefined,
    ledger.Intent.new(plan.ttl).addDeploy(deploy),
  );
  return {
    transaction,
    address: deploy.address,
    stateBytes: deploy.initialState.serialize(),
    operations,
    verifierKeyHashes,
    ttl: plan.ttl,
  };
};

/**
 * Check that a transaction still deploys exactly the built contract: one intent holds
 * a single `ContractDeploy` for the address with the built state, and no other intent
 * deploys anything or calls the contract.
 */
export const deployIntentCheck =
  (built: BuiltDeploy) =>
  (tx: AnyTransaction, stage: string): void => {
    const fail = (detail: string): never => {
      throw new PackageCheckError(stage, detail);
    };
    let found = 0;
    for (const [, intent] of tx.intents ?? []) {
      for (const action of intent.actions) {
        if (action instanceof ledger.ContractDeploy) {
          if (action.address !== built.address) fail("an intent deploys another contract");
          if (!bytesEqual(action.initialState.serialize(), built.stateBytes)) {
            fail("the deployed state differs from the built state");
          }
          if (intent.actions.length !== 1) fail("the deploy intent carries other actions");
          found += 1;
        } else if (action instanceof ledger.ContractCall && action.address === built.address) {
          fail("an intent calls the contract being deployed");
        }
      }
    }
    if (found !== 1) fail(`expected one deployment of ${built.address}, found ${String(found)}`);
  };
