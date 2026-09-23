#!/usr/bin/env bash
# External-consumer check (FR-015, SC-008): the consumer example builds and runs as a
# SEPARATE project that installs this library from its packed tarball and imports only
# the package's public entry points.
#
#   1. npm run build, then npm pack the library (the tarball must not contain tests/ or
#      examples/)
#   2. the example's sources may import only the package name, their own files and
#      their own generated binding (no path into src/, tests/ or the reference emitter)
#   3. copy examples/consumer (sources, committed keys, generated binding) into a temporary
#      directory, point its dependency at the tarball, install it with npm (the example's
#      own `overrides` keep one ledger-v9 and one compact-runtime), type-check and compile it
#      with its own tsconfig, and run its offline demo
#
# Run inside the pinned Node image after `npm run compile` (scripts/docker/run.sh does both).
# Needs network access to the npm registry for the separate install.
set -euo pipefail
cd "$(dirname "$0")/.."
repo="$(pwd -P)"

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
if tar -tzf "${work}/library.tgz" | grep -Eq '^package/(tests|examples)/'; then
  echo "the packed library contains tests/ or examples/" >&2
  exit 1
fi
echo "packed library: $(tar -tzf "${work}/library.tgz" | wc -l | tr -d ' ') files"

bad="$(grep -rhoE "from \"[^\"]+\"" examples/consumer/src | sed -E 's/from "([^"]+)"/\1/' | sort -u |
  grep -Ev '^(compact-multi-segment-emit/(codec|codec/raw-transaction|transaction|contract|adapters)|@midnight-ntwrk/compact-runtime|@midnightntwrk/ledger-v9|node:[a-z]+|\./[a-z-]+\.js|\.\./managed/consumer/contract/index\.js)$' || true)"
if [[ -n "${bad}" ]]; then
  echo "the consumer example imports outside its allowed set:" >&2
  echo "${bad}" >&2
  exit 1
fi
echo "consumer imports: public entry points, runtime/ledger, node built-ins, its own files and binding"

project="${work}/consumer"
mkdir -p "${project}/managed"
cp -R examples/consumer/src examples/consumer/keys examples/consumer/tsconfig.build.json "${project}/"
cp -R examples/consumer/managed/consumer "${project}/managed/"
node -e '
  const fs = require("node:fs");
  const example = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  example.dependencies["compact-multi-segment-emit"] = "file:../library.tgz";
  fs.writeFileSync(process.argv[2], JSON.stringify(example, null, 2) + "\n");
' "${repo}/examples/consumer/package.json" "${project}/package.json"
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
  const ok =
    report.publications.length === 2 &&
    report.publications.every((p) => p.fromEvents === "Complete, message equal" &&
      p.fromRawTransaction === "accepted, guaranteed-only placement" && p.stateUnchangedByPublication) &&
    report.refusals.length === 3 && report.announcements === "1" && report.releasedStillRegistered === false;
  for (const p of report.publications) console.log(`  ${p.owner}: ${p.parts} parts, ${p.bytes} bytes, request ${p.requestId}: ${p.fromEvents}; ${p.fromRawTransaction}`);
  if (!ok) { console.error(JSON.stringify(report, null, 2)); process.exit(1); }
' "${work}/report.json"
echo "external consumer check passed"
