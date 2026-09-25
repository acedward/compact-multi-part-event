#!/usr/bin/env bash
# Proving artifacts of the deployable examples.
#
#   scripts/keys.sh update [emitter|notice-board|all]   regenerate keys (compile --zk into
#       build/zk/<name>), copy the small verifier keys to the committed keys directory and
#       record the SHA-256 of every generated artifact in its SHA256SUMS
#   scripts/keys.sh verify [emitter|notice-board|all]   regenerate keys and require every
#       hash to match the committed SHA256SUMS and every committed verifier key
#
# Both modes then report each provable circuit's size (k, rows, table rows) with
# `zkir-v3 mock-compile -v`; values from compactc 0.34.0 are provisional.
#
# Prover keys (megabytes each) are never committed; their hashes are recorded so a
# rebuilt or downloaded copy can be checked. Needs the Compact toolchain on PATH and the
# Midnight public parameters (MIDNIGHT_PP, see scripts/docker/fetch-zk-params.sh).
set -euo pipefail
cd "$(dirname "$0")/.."

mode="${1:-}"
which="${2:-all}"
# Committed keys directory per example (no associative arrays: macOS ships bash 3.2).
committed_of() {
  case "$1" in
    emitter) echo contract-examples/emitter/keys ;;
    notice-board) echo contract-examples/notice-board/keys ;;
  esac
}

case "${mode}" in
  update | verify) ;;
  *)
    echo "usage: $0 update|verify [emitter|notice-board|all]" >&2
    exit 2
    ;;
esac

sizes=()
run_one() {
  local name="$1"
  local build="build/zk/${name}" committed
  committed="$(committed_of "${name}")"
  scripts/compile-contracts.sh --zk "${name}" >/dev/null
  local circuits=()
  for key in "${build}"/keys/*.verifier; do circuits+=("$(basename "${key}" .verifier)"); done
  local artifacts=()
  for circuit in "${circuits[@]}"; do
    local vk_hash
    vk_hash="$(sha256sum "${build}/keys/${circuit}.verifier" | cut -d' ' -f1)"
    if ! grep -q "'${circuit}': '${vk_hash}'" "${build}/contract/index.js"; then
      echo "${name}: generated expectedVk does not match the generated ${circuit} verifier key" >&2
      exit 1
    fi
    artifacts+=("keys/${circuit}.verifier" "keys/${circuit}.prover" "zkir/${circuit}.bzkir" "zkir/${circuit}.zkir")
    local model
    model="$(zkir-v3 mock-compile -v "${build}/zkir/${circuit}.zkir" 2>&1 | grep -o 'CircuitModel {[^}]*}')"
    field() { echo "${model}" | grep -o "$1: [0-9]*" | head -1 | awk '{print $2}'; }
    sizes+=("$(printf '%s\t%s\t%s\t%s\t%s\t%s' "${name}" "${circuit}" "$(field k)" "$(field rows)" "$(field table_rows)" "${vk_hash}")")
  done
  case "${mode}" in
    update)
      mkdir -p "${committed}"
      rm -f "${committed}"/*.verifier
      for circuit in "${circuits[@]}"; do
        cp "${build}/keys/${circuit}.verifier" "${committed}/${circuit}.verifier"
      done
      (cd "${build}" && sha256sum "${artifacts[@]}") >"${committed}/SHA256SUMS"
      cat "${committed}/SHA256SUMS"
      ;;
    verify)
      local sums
      sums="$(pwd -P)/${committed}/SHA256SUMS"
      (cd "${build}" && sha256sum -c --quiet "${sums}")
      for circuit in "${circuits[@]}"; do
        cmp "${build}/keys/${circuit}.verifier" "${committed}/${circuit}.verifier"
      done
      local listed
      listed="$(wc -l <"${committed}/SHA256SUMS")"
      if [[ "${listed}" -ne "${#artifacts[@]}" ]]; then
        echo "${name}: SHA256SUMS lists ${listed} files, the build has ${#artifacts[@]}" >&2
        exit 1
      fi
      if ls "${committed}"/*.verifier | grep -qv -F -f <(printf '%s.verifier\n' "${circuits[@]}"); then
        echo "${name}: ${committed} holds a verifier key the build does not produce" >&2
        exit 1
      fi
      echo "${name}: ${#circuits[@]} circuits; regenerated artifacts match ${committed}/SHA256SUMS; committed verifier keys are identical"
      ;;
  esac
}

for name in emitter notice-board; do
  if [[ "${which}" == "all" || "${which}" == "${name}" ]]; then run_one "${name}"; fi
done

echo "# circuit sizes (provisional): compactc $(compactc --version) --feature-zkir-v3; zkir-v3 $(zkir-v3 --version | awk '{print $2}') mock-compile -v"
printf 'example\tcircuit\tk\trows\ttable_rows\tverifier_key_sha256\n'
printf '%s\n' "${sizes[@]}"
