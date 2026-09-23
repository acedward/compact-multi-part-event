#!/usr/bin/env bash
# Proving artifacts of the deployable contracts (FR-018).
#
#   scripts/keys.sh update [emitter|consumer|all]   regenerate keys (compile --zk into
#       build/zk/<name>), copy the small verifier keys to the committed keys directory and
#       record the SHA-256 of every generated artifact in its SHA256SUMS
#   scripts/keys.sh verify [emitter|consumer|all]   regenerate keys and require every hash
#       to match the committed SHA256SUMS and every committed verifier key
#
# Prover keys (tens to hundreds of MB) are never committed; their hashes are recorded so
# a rebuilt or downloaded copy can be checked. Needs the Compact toolchain on PATH and
# the Midnight public parameters (MIDNIGHT_PP, see scripts/docker/seed-zk-params.sh).
set -euo pipefail
cd "$(dirname "$0")/.."

mode="${1:-}"
which="${2:-all}"
# Committed keys directory per contract (no associative arrays: macOS ships bash 3.2).
committed_of() {
  case "$1" in
    emitter) echo contracts/keys/emitter ;;
    consumer) echo examples/consumer/keys ;;
  esac
}

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
      echo "${name}: ${#circuits[@]} circuits; regenerated artifacts match ${committed}/SHA256SUMS; committed verifier keys are identical"
      ;;
    *)
      echo "usage: $0 update|verify [emitter|consumer|all]" >&2
      exit 2
      ;;
  esac
}

for name in emitter consumer; do
  if [[ "${which}" == "all" || "${which}" == "${name}" ]]; then run_one "${name}"; fi
done
