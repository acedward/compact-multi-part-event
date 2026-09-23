#!/usr/bin/env bash
# Compile every Compact source with compactc 0.34.0 and ZKIR v3.
#
# Usage: scripts/compile-contracts.sh          # skip-zk build (default checks)
#        scripts/compile-contracts.sh --zk     # additionally generate keys for the
#                                              # reference emitter into build/zk/emitter
#
# Needs the release's `compactc` wrapper (or COMPACTC) and `zkir-v3` on PATH;
# scripts/docker/run.sh provides both from the verified release archive.
# The --feature-zkir-v3 flag is explicit because 0.34.0 still defaults to ZKIR v2.
set -euo pipefail
cd "$(dirname "$0")/.."

COMPACTC="${COMPACTC:-compactc}"
expected_version="0.34.0"
actual_version="$("${COMPACTC}" --version)"
if [[ "${actual_version}" != "${expected_version}" ]]; then
  echo "compactc ${actual_version} found, ${expected_version} required" >&2
  exit 1
fi
echo "compactc ${actual_version}; runtime $("${COMPACTC}" --runtime-version); ledger $("${COMPACTC}" --ledger-version)"

compile() {
  local source="$1" target="$2"
  shift 2
  rm -rf "${target}"
  echo "== ${source} -> ${target} ${*:-}"
  "${COMPACTC}" --feature-zkir-v3 "$@" "${source}" "${target}"
}

compile contracts/emitter.compact contracts/managed/emitter --skip-zk
compile tests/contracts/registry-emitter.compact tests/contracts/managed/registry-emitter --skip-zk
compile tests/contracts/registry-sizes.compact tests/contracts/managed/registry-sizes --skip-zk

# Negative fixture: a pure circuit that emits must be rejected by the compiler.
fixture_out="$(mktemp -d)"
fixture_log="$(mktemp)"
if "${COMPACTC}" --feature-zkir-v3 --skip-zk tests/contracts/fixtures/pure-emit.compact \
  "${fixture_out}" >"${fixture_log}" 2>&1; then
  echo "tests/contracts/fixtures/pure-emit.compact compiled, but it must fail" >&2
  exit 1
fi
if ! grep -qi "impure" "${fixture_log}"; then
  echo "pure-emit fixture failed for an unexpected reason:" >&2
  cat "${fixture_log}" >&2
  exit 1
fi
echo "== negative fixture rejected as expected: $(grep -i -m1 "impure" "${fixture_log}")"
rm -rf "${fixture_out}" "${fixture_log}"

if [[ "${1:-}" == "--zk" ]]; then
  compile contracts/emitter.compact build/zk/emitter
fi
