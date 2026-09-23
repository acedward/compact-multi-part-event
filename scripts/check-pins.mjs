// Require exactly one installed copy of each package forced by the `overrides` of the
// project's package.json (ledger-v9, compact-runtime, onchain-runtime-v4), at the
// overridden version: two copies of the ledger or runtime in one process break
// `instanceof` checks and mix incompatible wasm objects.
//
// Usage: node scripts/check-pins.mjs [project directory]   (default: this repository)
// Run it after `npm ci` / `npm install`.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const project = resolve(process.argv[2] ?? fileURLToPath(new URL("..", import.meta.url)));
const pins = JSON.parse(readFileSync(resolve(project, "package.json"), "utf8")).overrides ?? {};
const names = Object.keys(pins);
if (names.length === 0) {
  console.error(`${project}/package.json has no overrides`);
  process.exit(1);
}

// `npm ls` exits non-zero when the installed tree does not match package.json/lockfile.
const tree = JSON.parse(
  execFileSync("npm", ["ls", "--all", "--json", ...names], { cwd: project, encoding: "utf8" }),
);

const found = new Map(names.map((name) => [name, new Set()]));
const walk = (node) => {
  for (const [name, child] of Object.entries(node.dependencies ?? {})) {
    if (found.has(name) && child.version !== undefined) found.get(name).add(child.version);
    walk(child);
  }
};
walk(tree);

let ok = true;
for (const [name, versions] of found) {
  const list = [...versions].sort();
  if (list.length !== 1 || list[0] !== pins[name]) {
    console.error(
      `${name}: expected one copy at ${pins[name]}, found ${list.join(", ") || "none"}`,
    );
    ok = false;
  } else {
    console.log(`${name} ${list[0]}: one copy`);
  }
}
if (!ok) process.exit(1);
