/**
 * Test access to compiler output. `npm run compile` must have run; production code
 * never imports these generated bindings.
 */
import { readFileSync } from "node:fs";

import {
  CompactTypeBytes,
  type ContractState,
  createCircuitContext,
  createConstructorContext,
  type LogEvent,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";

import * as emitterBinding from "../../contracts/managed/emitter/contract/index.js";
import * as registryBinding from "../contracts/managed/registry-emitter/contract/index.js";
import {
  type EmitterPrivateState,
  emitterWitnesses,
  type MessageOwnerPrivateState,
  messageOwnerWitnesses,
} from "../../src/contract/index.js";

export { emitterBinding, registryBinding };

export const COIN_PUBLIC_KEY = "0".repeat(64);

export const repoFile = (path: string): URL => new URL(`../../${path}`, import.meta.url);

/** Committed reference-emitter verifier key (contracts/keys/emitter). */
export const EMITTER_VERIFIER_KEY = new Uint8Array(
  readFileSync(repoFile("contracts/keys/emitter/emitPart.verifier")),
);

export const contractInfo = (managedDir: string): ContractInfo =>
  JSON.parse(
    readFileSync(repoFile(`${managedDir}/compiler/contract-info.json`), "utf8"),
  ) as ContractInfo;

export interface ContractInfo {
  readonly "compiler-version": string;
  readonly "runtime-version": string;
  readonly circuits: readonly {
    readonly name: string;
    readonly pure: boolean;
    readonly proof: boolean;
  }[];
  readonly witnesses: readonly { readonly name: string }[];
  readonly ledger: readonly {
    readonly name: string;
    readonly storage: string;
    readonly exported: boolean;
  }[];
}

export const emitterContract = (): emitterBinding.Contract<EmitterPrivateState> =>
  new emitterBinding.Contract<EmitterPrivateState>(emitterWitnesses);

export const registryContract = (): registryBinding.Contract<MessageOwnerPrivateState> =>
  new registryBinding.Contract<MessageOwnerPrivateState>(messageOwnerWitnesses);

/** Initial reference-emitter state for an authority commitment. */
export const emitterInitialState = async (authority: Uint8Array): Promise<ContractState> => {
  const initial = await emitterContract().initialState(
    createConstructorContext<EmitterPrivateState>(
      { emitterSecret: new Uint8Array(32) },
      COIN_PUBLIC_KEY,
    ),
    authority,
  );
  return initial.currentContractState;
};

export const registryInitialState = async (): Promise<ContractState> => {
  const initial = await registryContract().initialState(
    createConstructorContext<MessageOwnerPrivateState>(
      { messageOwnerSecret: new Uint8Array(32) },
      COIN_PUBLIC_KEY,
    ),
  );
  return initial.currentContractState;
};

export const sampleAddress = (): string => sampleContractAddress();

export const context = <PS>(
  circuit: string,
  address: string,
  state: Parameters<typeof createCircuitContext>[3],
  privateState: PS,
) => createCircuitContext<PS>(circuit, address, COIN_PUBLIC_KEY, state, privateState);

/** Decode a runtime `Misc` log event into its 288 bytes (on a copy of the atoms). */
export const miscBytes = (event: LogEvent): Uint8Array => {
  if (event.eventType !== "misc") throw new Error(`event type ${event.eventType}`);
  if (event.data.tag !== "cell") throw new Error(`event data ${event.data.tag}`);
  const cursor = [...event.data.content.value];
  const bytes = new CompactTypeBytes(288).fromValue(cursor);
  if (cursor.length !== 0) throw new Error("trailing atoms");
  return bytes;
};
