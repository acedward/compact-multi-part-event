/**
 * The examples deploy-tools knows: the reference emitter (`example:message[v1]`) and the
 * notice board (`notice-board:notice[v1]`, state of its own). Both use the example
 * whitelist. Their generated bindings are compiler OUTPUT, loaded at run time from the
 * example's `managed/` directory by path, so no library module imports generated code.
 *
 * @module
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type {
  CircuitContext,
  CircuitResults,
  ConstructorContext,
  ContractState,
} from "@midnight-ntwrk/compact-runtime";

import { UsageError } from "../src/cli/options.js";

/** An example's name. */
export type ExampleName = "emitter" | "notice-board";

/** Where an example's source, generated binding, keys and full key build live. */
export interface ExampleProfile {
  readonly name: ExampleName;
  /** The event name N the example's protocol opted into the multi-part rule. */
  readonly eventName: string;
  /** The emitting circuit. */
  readonly entryPoint: "emitPart";
  /** `compactc --skip-zk` output (generated binding and contract-info). */
  readonly managedDir: string;
  /** Committed verifier keys and their SHA256SUMS. */
  readonly keysDir: string;
  /** Full key build used for proving (`npm run compile:zk`). */
  readonly zkDir: string;
  /**
   * A text message in the example protocol's payload format: the reference emitter's
   * payload is the UTF-8 text; the notice board's is its notice format (4-byte
   * big-endian length, then the UTF-8 text; `contract-examples/notice-board/src`).
   */
  readonly encodeText: (text: string) => Uint8Array;
}

/** The repository root (this file is `deploy-tools/` below it). */
export const repositoryRoot = (): string => resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** A notice in the notice board's format: u32 big-endian length, then the UTF-8 text. */
export const encodeNoticeText = (text: string): Uint8Array => {
  const body = new TextEncoder().encode(text);
  const out = new Uint8Array(4 + body.byteLength);
  new DataView(out.buffer).setUint32(0, body.byteLength, false);
  out.set(body, 4);
  return out;
};

/** The two examples, with paths below `root`. */
export const exampleProfiles = (
  root = repositoryRoot(),
): Readonly<Record<ExampleName, ExampleProfile>> => ({
  emitter: {
    name: "emitter",
    eventName: "example:message[v1]",
    entryPoint: "emitPart",
    managedDir: join(root, "contract-examples/emitter/managed"),
    keysDir: join(root, "contract-examples/emitter/keys"),
    zkDir: join(root, "build/zk/emitter"),
    encodeText: (text) => new TextEncoder().encode(text),
  },
  "notice-board": {
    name: "notice-board",
    eventName: "notice-board:notice[v1]",
    entryPoint: "emitPart",
    managedDir: join(root, "contract-examples/notice-board/managed"),
    keysDir: join(root, "contract-examples/notice-board/keys"),
    zkDir: join(root, "build/zk/notice-board"),
    encodeText: encodeNoticeText,
  },
});

/**
 * The profile named by `--example`.
 *
 * @throws {UsageError} For a missing or unknown name.
 */
export const profileOf = (name: string | undefined, root = repositoryRoot()): ExampleProfile => {
  const profiles = exampleProfiles(root);
  if (name === "emitter" || name === "notice-board") return profiles[name];
  throw new UsageError("--example is required: emitter or notice-board");
};

/** The generated contract class, as far as deploy-tools uses it. */
export interface GeneratedContract {
  readonly impureCircuits: Readonly<
    Record<
      string,
      (
        context: CircuitContext<unknown>,
        ...args: unknown[]
      ) => Promise<CircuitResults<unknown, unknown>>
    >
  >;
  initialState(
    context: ConstructorContext<unknown>,
    ...args: unknown[]
  ): Promise<{ readonly currentContractState: ContractState }>;
}

/** A generated contract module (`managed/contract/index.js`). */
export interface GeneratedModule {
  readonly Contract: new (witnesses: object) => GeneratedContract;
  readonly ledger: (state: unknown) => Record<string, unknown>;
  readonly pureCircuits: Readonly<Record<string, (...args: unknown[]) => unknown>>;
}

/**
 * Load an example's generated binding.
 *
 * @throws {UsageError} If it has not been compiled.
 */
export const loadGeneratedModule = async (profile: ExampleProfile): Promise<GeneratedModule> => {
  const path = join(profile.managedDir, "contract/index.js");
  if (!existsSync(path)) {
    throw new UsageError(`${path} does not exist; run npm run compile first`);
  }
  return (await import(pathToFileURL(path).href)) as GeneratedModule;
};

interface ContractInfo {
  readonly circuits: readonly { readonly name: string; readonly proof: boolean }[];
}

/** Names of the example's provable circuits (from the compiler's contract-info). */
export const provableCircuits = (profile: ExampleProfile): string[] => {
  const path = join(profile.managedDir, "compiler/contract-info.json");
  if (!existsSync(path)) throw new UsageError(`${path} does not exist; run npm run compile first`);
  const info = JSON.parse(readFileSync(path, "utf8")) as ContractInfo;
  return info.circuits
    .filter((circuit) => circuit.proof)
    .map((circuit) => circuit.name)
    .sort();
};

/** The committed verifier key of every provable circuit. */
export const committedVerifierKeys = (profile: ExampleProfile): Record<string, Uint8Array> => {
  const keys: Record<string, Uint8Array> = {};
  for (const circuit of provableCircuits(profile)) {
    const path = join(profile.keysDir, `${circuit}.verifier`);
    if (!existsSync(path)) throw new UsageError(`missing committed verifier key ${path}`);
    keys[circuit] = new Uint8Array(readFileSync(path));
  }
  return keys;
};
