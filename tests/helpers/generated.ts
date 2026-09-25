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

import * as emitterModule from "../../contract-examples/emitter/managed/contract/index.js";
import * as noticeBoardModule from "../../contract-examples/notice-board/managed/contract/index.js";
import {
  type EmitterPrivateState,
  emitterWitnesses,
} from "../../contract-examples/whitelist/whitelist.js";
import * as openEmitterModule from "../contracts/managed/open-emitter/contract/index.js";

export { emitterModule, noticeBoardModule, openEmitterModule };

/** The reference emitter's event name. */
export const EXAMPLE_NAME = "example:message[v1]";

/** The notice board's event name. */
export const NOTICE_NAME = "notice-board:notice[v1]";

export const COIN_PUBLIC_KEY = "0".repeat(64);

export const repoFile = (path: string): URL => new URL(`../../${path}`, import.meta.url);

const committedKey = (path: string): Uint8Array => new Uint8Array(readFileSync(repoFile(path)));

/** Committed reference-emitter verifier key. */
export const EMITTER_VERIFIER_KEY = committedKey(
  "contract-examples/emitter/keys/emitPart.verifier",
);

/** Committed notice-board verifier keys. */
export const BOARD_VERIFIER_KEYS: Readonly<Record<string, Uint8Array>> = {
  emitPart: committedKey("contract-examples/notice-board/keys/emitPart.verifier"),
  pin: committedKey("contract-examples/notice-board/keys/pin.verifier"),
};

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

export const emitterContract = (): emitterModule.Contract<EmitterPrivateState> =>
  new emitterModule.Contract<EmitterPrivateState>(emitterWitnesses);

export const openEmitterContract = (): openEmitterModule.Contract<undefined> =>
  new openEmitterModule.Contract<undefined>({});

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

/** Initial open-emitter state (it has no state and no constructor argument). */
export const openEmitterInitialState = async (): Promise<ContractState> => {
  const initial = await openEmitterContract().initialState(
    createConstructorContext<undefined>(undefined, COIN_PUBLIC_KEY),
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
