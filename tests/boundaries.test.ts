/**
 * Dependency boundaries (spec "Standalone repository content and dependency
 * boundaries"), checked on the source import graph:
 * - the codec entry point reaches only Node built-ins and codec modules (no ledger,
 *   wallet, network, prover or generated contract code);
 * - no production module imports tests, examples, generated contract output, or a
 *   test runner;
 * - the transaction module does not import a generated `Contract`.
 */
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const importsOf = (file: string): string[] => {
  const source = readFileSync(file, "utf8");
  const specifiers: string[] = [];
  for (const match of source.matchAll(/(?:^|\n)\s*(?:import|export)[^;]*?from\s+"([^"]+)"/g)) {
    if (match[1] !== undefined) specifiers.push(match[1]);
  }
  for (const match of source.matchAll(/import\(\s*"([^"]+)"\s*\)/g)) {
    if (match[1] !== undefined) specifiers.push(match[1]);
  }
  return specifiers;
};

const resolveLocal = (from: string, specifier: string): string =>
  join(dirname(from), specifier).replace(/\.js$/, ".ts");

/** Every file and bare/builtin specifier reachable from `entry`. */
const reachable = (entry: string): { files: Set<string>; external: Set<string> } => {
  const files = new Set<string>();
  const external = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || files.has(file)) continue;
    files.add(file);
    for (const specifier of importsOf(file)) {
      if (specifier.startsWith(".")) queue.push(resolveLocal(file, specifier));
      else external.add(specifier);
    }
  }
  return { files, external };
};

const productionEntries = [
  "src/codec/index.ts",
  "src/codec/raw-transaction.ts",
  "src/transaction/index.ts",
  "src/contract/index.ts",
].map((path) => join(root, path));

describe("dependency boundaries", () => {
  it("the codec entry point needs only node:crypto and codec modules", () => {
    const { files, external } = reachable(join(root, "src/codec/index.ts"));
    expect([...external].sort()).toEqual(["node:crypto"]);
    for (const file of files) expect(relative(root, file).startsWith("src/codec/")).toBe(true);
    expect([...files].map((file) => relative(root, file))).not.toContain(
      "src/codec/raw-transaction.ts",
    );
  });

  it("raw-transaction extraction adds only the ledger package", () => {
    const { external } = reachable(join(root, "src/codec/raw-transaction.ts"));
    expect([...external].sort()).toEqual(["@midnightntwrk/ledger-v9", "node:crypto"]);
  });

  it("no production module reaches tests, examples, generated output or a test runner", () => {
    for (const entry of productionEntries) {
      const { files, external } = reachable(entry);
      for (const file of files) {
        const path = relative(root, file);
        expect(path.startsWith("src/"), `${path} (from ${relative(root, entry)})`).toBe(true);
        expect(path).not.toMatch(/managed|tests\/|examples\//);
      }
      for (const specifier of external) {
        expect(specifier).not.toMatch(/vitest|managed|contract\/index/);
      }
    }
  });

  it("the transaction composer depends only on the ledger, the runtime and the codec", () => {
    const { external } = reachable(join(root, "src/transaction/index.ts"));
    expect([...external].sort()).toEqual([
      "@midnight-ntwrk/compact-runtime",
      "@midnightntwrk/ledger-v9",
      "node:crypto",
      "node:util",
    ]);
  });
});
