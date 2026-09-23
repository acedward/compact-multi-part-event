#!/usr/bin/env bash
# Reference-emitter proving artifacts (FR-018).
#
#   scripts/keys.sh update   regenerate keys (compile --zk into build/zk/emitter), then
#                            commit-ready: copy the small verifier key to
#                            contracts/keys/emitter/ and record the SHA-256 of every
#                            generated artifact in contracts/keys/emitter/SHA256SUMS
#   scripts/keys.sh verify   regenerate keys and require every hash to match the
#                            committed SHA256SUMS and the committed verifier key
#
# The prover key (~180 MB) is never committed; its hash is recorded so a rebuilt
# or downloaded copy can be checked. Needs the Compact toolchain on PATH and the
# Midnight public parameters (MIDNIGHT_PP, see scripts/docker/seed-zk-params.sh).
set -euo pipefail
cd "$(dirname "$0")/.."

mode="${1:-}"
build="build/zk/emitter"
committed="contracts/keys/emitter"
artifacts=(keys/emitPart.verifier keys/emitPart.prover zkir/emitPart.bzkir zkir/emitPart.zkir)

scripts/compile-contracts.sh --zk >/dev/null
vk_hash="$(sha256sum "${build}/keys/emitPart.verifier" | cut -d' ' -f1)"
if ! grep -q "'emitPart': '${vk_hash}'" "${build}/contract/index.js"; then
  echo "generated expectedVk does not match the generated verifier key" >&2
  exit 1
fi

case "${mode}" in
  update)
    mkdir -p "${committed}"
    cp "${build}/keys/emitPart.verifier" "${committed}/emitPart.verifier"
    (cd "${build}" && sha256sum "${artifacts[@]}") >"${committed}/SHA256SUMS"
    cat "${committed}/SHA256SUMS"
    ;;
  verify)
    (cd "${build}" && sha256sum -c "../../../${committed}/SHA256SUMS")
    cmp "${build}/keys/emitPart.verifier" "${committed}/emitPart.verifier"
    echo "regenerated artifacts match ${committed}/SHA256SUMS; committed verifier key is identical"
    ;;
  *)
    echo "usage: $0 update|verify" >&2
    exit 2
    ;;
esac
