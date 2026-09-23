/**
 * The contracts the CLI knows: the reference emitter (single-emitter whitelist) and the
 * consumer example (per-message registration). Their generated bindings are compiler
 * OUTPUT, loaded at run time from the build directory by path, so no production
 * module imports generated code, examples or tests.
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

import { UsageError } from "./config.js";

/** Which access-control example a contract uses. */
export type AccessKind = "whitelist" | "registry";

/** Where a contract's source, build output and keys live. */
export interface ContractProfile {
  readonly name: "emitter" | "consumer";
  readonly access: AccessKind;
  /** `compactc --skip-zk` output (generated binding and contract-info). */
  readonly managedDir: string;
  /** Committed verifier keys and their SHA256SUMS. */
  readonly keysDir: string;
  /** Full key build used for proving (`npm run compile:zk`). */
  readonly zkDir: string;
}

/** The repository root (this file is `src/cli/` or `dist/cli/` below it). */
export const repositoryRoot = (): string =>
  resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The two contracts, with paths relative to `root`. */
export const contractProfiles = (
  root = repositoryRoot(),
): Readonly<Record<"emitter" | "consumer", ContractProfile>> => ({
  emitter: {
    name: "emitter",
    access: "whitelist",
    managedDir: join(root, "contracts/managed/emitter"),
    keysDir: join(root, "contracts/keys/emitter"),
    zkDir: join(root, "build/zk/emitter"),
  },
  consumer: {
    name: "consumer",
    access: "registry",
    managedDir: join(root, "examples/consumer/managed/consumer"),
    keysDir: join(root, "examples/consumer/keys"),
    zkDir: join(root, "build/zk/consumer"),
  },
});

/** The generated contract class, as far as the CLI uses it. */
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

/** A generated contract module (`contract/index.js`). */
export interface GeneratedModule {
  readonly Contract: new (witnesses: object) => GeneratedContract;
  readonly ledger: (state: unknown) => Record<string, unknown>;
  readonly pureCircuits: Readonly<Record<string, (...args: unknown[]) => unknown>>;
}

/** Load a compiled contract's generated binding. */
export const loadGeneratedModule = async (profile: ContractProfile): Promise<GeneratedModule> => {
  const path = join(profile.managedDir, "contract/index.js");
  if (!existsSync(path)) {
    throw new UsageError(`${path} does not exist; run npm run compile first`);
  }
  return (await import(pathToFileURL(path).href)) as GeneratedModule;
};

interface ContractInfo {
  readonly circuits: readonly { readonly name: string; readonly proof: boolean }[];
}

/** Names of the contract's provable circuits (from the compiler's contract-info). */
export const provableCircuits = (profile: ContractProfile): string[] => {
  const path = join(profile.managedDir, "compiler/contract-info.json");
  if (!existsSync(path)) throw new UsageError(`${path} does not exist; run npm run compile first`);
  const info = JSON.parse(readFileSync(path, "utf8")) as ContractInfo;
  return info.circuits
    .filter((circuit) => circuit.proof)
    .map((circuit) => circuit.name)
    .sort();
};

/** The committed verifier key of every provable circuit. */
export const committedVerifierKeys = (profile: ContractProfile): Record<string, Uint8Array> => {
  const keys: Record<string, Uint8Array> = {};
  for (const circuit of provableCircuits(profile)) {
    const path = join(profile.keysDir, `${circuit}.verifier`);
    if (!existsSync(path)) throw new UsageError(`missing committed verifier key ${path}`);
    keys[circuit] = new Uint8Array(readFileSync(path));
  }
  return keys;
};
