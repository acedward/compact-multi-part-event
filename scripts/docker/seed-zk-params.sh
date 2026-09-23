#!/usr/bin/env bash
# Copy Midnight public parameters (bls_midnight_2p<k> files) from a local cache into
# the ${CMSE_PARAMS_VOLUME} volume, so key generation and the local proof service
# need no download. Every consumer re-verifies the files' published SHA-256 when it
# reads them.
#
# Usage: CMSE_ZK_PARAMS_DIR=<dir with bls_midnight_2p*> scripts/docker/seed-zk-params.sh [max-k]
set -euo pipefail
source "$(dirname "$0")/common.sh"

max_k="${1:-17}"
: "${CMSE_ZK_PARAMS_DIR:?set CMSE_ZK_PARAMS_DIR to a directory containing bls_midnight_2p* files}"
files=()
for k in $(seq 10 "${max_k}"); do
  [[ -f "${CMSE_ZK_PARAMS_DIR}/bls_midnight_2p${k}" ]] || {
    echo "missing ${CMSE_ZK_PARAMS_DIR}/bls_midnight_2p${k}" >&2
    exit 1
  }
  files+=("bls_midnight_2p${k}")
done
docker volume inspect "${CMSE_PARAMS_VOLUME}" >/dev/null 2>&1 || docker volume create "${CMSE_PARAMS_VOLUME}" >/dev/null
tar_flags=()
if tar --version 2>/dev/null | grep -q bsdtar; then tar_flags+=(--no-mac-metadata --no-xattrs); fi
COPYFILE_DISABLE=1 tar -C "${CMSE_ZK_PARAMS_DIR}" ${tar_flags[@]+"${tar_flags[@]}"} -cf - "${files[@]}" |
  docker run --rm -i --name "${CMSE_DOCKER_PREFIX}-seed-params" -v "${CMSE_PARAMS_VOLUME}:/zk-params" \
    "${CMSE_NODE_IMAGE}" bash -c 'tar -C /zk-params -xf - && cd /zk-params && sha256sum bls_midnight_2p*'
