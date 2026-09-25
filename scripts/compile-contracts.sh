#!/usr/bin/env bash
# Compile every Compact source with compactc 0.34.0 and ZKIR v3.
#
# Usage: scripts/compile-contracts.sh               # skip-zk build (default checks)
#        scripts/compile-contracts.sh --zk [name]   # additionally generate keys into
#                                                   # build/zk/<name> for emitter,
#                                                   # notice-board or all (default all)
#
# Output: contract-examples/<example>/managed/ and tests/contracts/managed/<name>/
# (generated, never committed).
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

# Deployable examples: name -> source (no associative arrays: macOS ships bash 3.2).
source_of() {
  case "$1" in
    emitter) echo contract-examples/emitter/emitter.compact ;;
    notice-board) echo contract-examples/notice-board/notice-board.compact ;;
  esac
}

compile contract-examples/emitter/emitter.compact contract-examples/emitter/managed --skip-zk
compile contract-examples/notice-board/notice-board.compact contract-examples/notice-board/managed --skip-zk
compile tests/contracts/open-emitter.compact tests/contracts/managed/open-emitter --skip-zk

if [[ "${1:-}" == "--zk" ]]; then
  which="${2:-all}"
  for name in emitter notice-board; do
    if [[ "${which}" == "all" || "${which}" == "${name}" ]]; then
      compile "$(source_of "${name}")" "build/zk/${name}"
    fi
  done
fi
