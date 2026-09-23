#!/usr/bin/env bash
# Start or stop the local proof service used by the opt-in real-proof test.
#
#   scripts/docker/proof-server.sh up     create ${CMSE_NETWORK}, start ${CMSE_PROOF_CONTAINER}
#                                         on a random free 127.0.0.1 port above 10000, with
#                                         public parameters from ${CMSE_PARAMS_VOLUME} (seed it
#                                         with seed-zk-params.sh) and parameter fetching off
#   scripts/docker/proof-server.sh down   remove the container and the network
#
# Tests reach it inside the network at http://${CMSE_PROOF_CONTAINER}:6300.
# CMSE_PROOF_JOB_CAPACITY raises the server's queue (default 10 jobs): midnight-js 5
# sends one proof request per call at once, so larger publications need more.
set -euo pipefail
source "$(dirname "$0")/common.sh"

case "${1:-}" in
  up)
    docker network inspect "${CMSE_NETWORK}" >/dev/null 2>&1 || docker network create --label "${CMSE_LABEL}" "${CMSE_NETWORK}" >/dev/null
    port=""
    for _ in $(seq 1 50); do
      candidate=$((10001 + RANDOM % 50000))
      if ! (lsof -nP -iTCP:"${candidate}" -sTCP:LISTEN >/dev/null 2>&1) &&
        ! docker ps --format '{{.Ports}}' | grep -q ":${candidate}->"; then
        port="${candidate}"
        break
      fi
    done
    [[ -n "${port}" ]] || { echo "no free port found" >&2; exit 1; }
    docker rm -f "${CMSE_PROOF_CONTAINER}" >/dev/null 2>&1 || true
    docker run -d --label "${CMSE_LABEL}" --name "${CMSE_PROOF_CONTAINER}" --network "${CMSE_NETWORK}" \
      -p "127.0.0.1:${port}:6300" \
      -v "${CMSE_PARAMS_VOLUME}:/params" \
      -e MIDNIGHT_PP=/params \
      -e MIDNIGHT_PROOF_SERVER_NO_FETCH_PARAMS=true \
      ${CMSE_PROOF_JOB_CAPACITY:+-e MIDNIGHT_PROOF_SERVER_JOB_CAPACITY=${CMSE_PROOF_JOB_CAPACITY}} \
      "${CMSE_PROOF_IMAGE}" >/dev/null
    for _ in $(seq 1 60); do
      if curl -fsS "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then break; fi
      sleep 1
    done
    echo "image ${CMSE_PROOF_IMAGE} ($(docker image inspect "${CMSE_PROOF_IMAGE}" --format '{{.Id}}'))"
    echo "host 127.0.0.1:${port}; in-network http://${CMSE_PROOF_CONTAINER}:6300"
    echo "version $(curl -fsS "http://127.0.0.1:${port}/version"); proof versions $(curl -fsS "http://127.0.0.1:${port}/proof-versions")"
    ;;
  down)
    docker rm -f "${CMSE_PROOF_CONTAINER}" >/dev/null 2>&1 && echo "removed ${CMSE_PROOF_CONTAINER}" || true
    docker network rm "${CMSE_NETWORK}" >/dev/null 2>&1 && echo "removed ${CMSE_NETWORK}" || true
    ;;
  *)
    echo "usage: $0 up|down" >&2
    exit 2
    ;;
esac
