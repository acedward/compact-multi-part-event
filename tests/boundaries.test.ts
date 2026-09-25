/**
 * Dependency boundaries, checked on the source import graph:
 * - the reader reaches only the ledger package and its own modules (no runtime, wallet,
 *   network, prover or generated contract code);
 * - the publisher reaches only the ledger, the runtime, Node built-ins, the reader and
 *   its own modules;
 * - no library module (`src/reader`, `src/publisher`, `src/indexer`) reaches tests,
 *   examples, deploy-tools, generated output or a test runner;
 * - the notice-board example imports only the library's public entry points, the
 *   runtime and ledger packages, Node built-ins, its own files and its own binding.
 */
import { readdirSync, readFileSync } from "node:fs";
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

const rel = (files: Iterable<string>): string[] =>
  [...files].map((file) => relative(root, file)).sort();

describe("dependency boundaries", () => {
  it("the reader needs only the ledger package and its own modules", () => {
    const { files, external } = reachable(join(root, "src/reader/index.ts"));
    expect([...external].sort()).toEqual(["@midnightntwrk/ledger-v9"]);
    for (const file of rel(files)) expect(file.startsWith("src/reader/")).toBe(true);
  });

  it("the publisher needs only the ledger, the runtime, Node built-ins and the reader", () => {
    const { files, external } = reachable(join(root, "src/publisher/index.ts"));
    expect([...external].sort()).toEqual([
      "@midnight-ntwrk/compact-runtime",
      "@midnightntwrk/ledger-v9",
      "node:crypto",
      "node:util",
    ]);
    for (const file of rel(files)) expect(file).toMatch(/^src\/(publisher|reader)\//);
  });

  it("no library module reaches tests, examples, deploy-tools, generated output or a test runner", () => {
    for (const entry of ["src/reader/index.ts", "src/publisher/index.ts", "src/indexer/index.ts"]) {
      const { files, external } = reachable(join(root, entry));
      for (const path of rel(files)) {
        expect(path.startsWith("src/"), `${path} (from ${entry})`).toBe(true);
        expect(path).not.toMatch(/managed|tests\/|contract-examples\/|deploy-tools\/|src\/cli\//);
      }
      for (const specifier of external) {
        expect(specifier).not.toMatch(/vitest|managed|wallet-sdk|midnight-js|bip39|rxjs/);
      }
    }
  });

  it("the notice-board example imports only public entry points, runtime/ledger, built-ins, its own files and binding", () => {
    const dir = join(root, "contract-examples/notice-board/src");
    const allowed =
      /^(compact-multi-segment-emit\/(reader|publisher|indexer)|@midnight-ntwrk\/compact-runtime|@midnightntwrk\/ledger-v9|node:[a-z]+|\.\/[a-z-]+\.js|\.\.\/managed\/contract\/index\.js)$/;
    const specifiers = readdirSync(dir)
      .filter((file) => file.endsWith(".ts"))
      .flatMap((file) => importsOf(join(dir, file)));
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter((specifier) => !allowed.test(specifier))).toEqual([]);
  });
});
