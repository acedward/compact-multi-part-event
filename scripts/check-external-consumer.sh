#!/usr/bin/env bash
# Separate-project check: the notice-board example builds and runs as a
# SEPARATE project that installs this library from its packed tarball and imports only
# the package's public entry points.
#
#   1. npm run build, then npm pack the library: the tarball holds package.json,
#      LICENSE, README.md and dist/ with the library (reader, publisher, indexer) and the
#      cmse command only, and depends only on the Compact runtime and the ledger
#   2. the example's sources import only the package's public entry points, the runtime
#      and ledger packages, Node built-ins, their own files and their own binding
#   3. copy contract-examples/notice-board (sources, committed keys, generated binding)
#      into a temporary directory, point its dependency at the tarball, install it with
#      npm (its own `overrides` keep one ledger-v9 and one compact-runtime), check the
#      pins, type-check and compile it with its own tsconfig, and run its offline demo
#
# Run inside the pinned Node image after `npm run compile` (scripts/check.sh does both).
# Needs network access to the npm registry for the separate install.
set -euo pipefail
cd "$(dirname "$0")/.."
repo="$(pwd -P)"
example="contract-examples/notice-board"

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

npm run build >/dev/null
if ! tarball="$(npm pack --pack-destination "${work}" --json 2>"${work}/pack.log" | node -e '
  let input = "";
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("end", () => console.log(JSON.parse(input)[0].filename));
')"; then
  cat "${work}/pack.log" >&2
  exit 1
fi
mv "${work}/${tarball}" "${work}/library.tgz"
listing="$(tar -tzf "${work}/library.tgz")"
unexpected="$(echo "${listing}" |
  grep -Ev '^package/(package\.json|LICENSE|README\.md|dist/(reader|publisher|indexer|cli)/[a-z0-9-]+\.(js|js\.map|d\.ts|d\.ts\.map))$' || true)"
if [[ -n "${unexpected}" ]]; then
  echo "the packed library holds files outside package.json, LICENSE, README.md and dist/{reader,publisher,indexer,cli}:" >&2
  echo "${unexpected}" >&2
  exit 1
fi
tar -xzf "${work}/library.tgz" -C "${work}" package/package.json
node -e '
  const pkg = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  const deps = Object.keys(pkg.dependencies ?? {}).sort().join(", ");
  const exports = Object.keys(pkg.exports ?? {}).sort().join(", ");
  if (deps !== "@midnight-ntwrk/compact-runtime, @midnightntwrk/ledger-v9") {
    console.error(`the packed library depends on ${deps}`);
    process.exit(1);
  }
  if (exports !== "./indexer, ./publisher, ./reader" || pkg.bin?.cmse !== "dist/cli/main.js") {
    console.error(`unexpected exports (${exports}) or bin (${JSON.stringify(pkg.bin)})`);
    process.exit(1);
  }
' "${work}/package/package.json"
echo "packed library: $(echo "${listing}" | wc -l | tr -d ' ') files (package.json, LICENSE, README.md, dist/{reader,publisher,indexer,cli}); exports ./reader ./publisher ./indexer; bin cmse; depends on compact-runtime and ledger-v9 only"

bad="$(grep -rhoE "from \"[^\"]+\"" "${example}/src" | sed -E 's/from "([^"]+)"/\1/' | sort -u |
  grep -Ev '^(compact-multi-segment-emit/(reader|publisher|indexer)|@midnight-ntwrk/compact-runtime|@midnightntwrk/ledger-v9|node:[a-z]+|\./[a-z-]+\.js|\.\./managed/contract/index\.js)$' || true)"
if [[ -n "${bad}" ]]; then
  echo "the notice-board example imports outside its allowed set:" >&2
  echo "${bad}" >&2
  exit 1
fi
echo "notice-board imports: public entry points, runtime/ledger, node built-ins, its own files and binding"

project="${work}/notice-board"
mkdir -p "${project}"
cp -R "${example}/src" "${example}/keys" "${example}/managed" "${example}/tsconfig.build.json" "${project}/"
node -e '
  const fs = require("node:fs");
  const example = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  example.dependencies["compact-multi-segment-emit"] = "file:../library.tgz";
  fs.writeFileSync(process.argv[2], JSON.stringify(example, null, 2) + "\n");
' "${repo}/${example}/package.json" "${project}/package.json"
cp .npmrc "${project}/.npmrc"

cd "${project}"
npm install >"${work}/install.log" 2>&1 || {
  tail -30 "${work}/install.log" >&2
  exit 1
}
echo "separate install: compact-multi-segment-emit $(node -p 'require("./node_modules/compact-multi-segment-emit/package.json").version') from the tarball"
node "${repo}/scripts/check-pins.mjs" "${project}"
npm run build >/dev/null
node dist/offline-demo.js >"${work}/report.json"
node -e '
  const report = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  const [single, several] = report.transactions;
  const notices = report.transactions.flatMap((tx) => tx.notices);
  const ok =
    report.transactions.length === 2 &&
    single.intents === 1 && single.packages === 1 && single.notices.length === 1 &&
    several.intents === 2 && several.packages === 2 && several.notices.length === 2 &&
    report.transactions.every((tx) => tx.stateUnchanged) &&
    notices.every((n) => n.fromEvents === "accepted, notice equal" &&
      n.fromRawTransaction === "guaranteed-only placement, notice equal") &&
    report.refusals.length === 1 && report.pinnedCount === "1" &&
    report.pinnedDigestIsNoticeSha256 === true;
  for (const [index, tx] of report.transactions.entries()) {
    for (const n of tx.notices) {
      console.log(`  transaction ${index + 1} (${tx.intents} intent(s)): segment ${n.segment}, ${n.parts} part(s), "${n.notice}": ${n.fromEvents}; ${n.fromRawTransaction}`);
    }
  }
  console.log(`  refused: ${report.refusals.length}; pinnedCount ${report.pinnedCount}`);
  if (!ok) { console.error(JSON.stringify(report, null, 2)); process.exit(1); }
' "${work}/report.json"
echo "external consumer check passed"
