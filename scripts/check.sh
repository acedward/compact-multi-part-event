#!/usr/bin/env bash
# The one check entry point. Everything that builds or tests runs in Docker;
# no wallet, mnemonic, network account or live transaction is used.
#
#   scripts/check.sh                 check this working tree
#   scripts/check.sh --fresh-clone   clone the committed HEAD into a clean temporary
#                                    directory and check that, with fresh Docker volumes
#                                    (empty package cache: every dependency is installed
#                                    from the lockfile)
#
# In the pinned Node image (scripts/check-in-container.sh): `npm ci` from the committed
# package-lock.json, one copy of each pinned ledger/runtime package, compile, key
# regeneration against the committed hashes (with each circuit's k and rows), format,
# type-aware lint, typecheck, build, tests, and the separate-project build of the
# notice-board example. Then, on the host's Git data, the repository check: the label
# policy over the working tree and the full history, and the repository layout.
# Docker resources are named ${CMSE_DOCKER_PREFIX}-* (default cmse); remove them with
# scripts/docker/teardown.sh.
set -euo pipefail
source "$(dirname "$0")/docker/common.sh"

if [[ "${1:-}" == "--fresh-clone" ]]; then
  clone_root="$(mktemp -d)"
  trap 'rm -rf "${clone_root}"' EXIT
  git clone --quiet --no-local "${CMSE_REPO_DIR}" "${clone_root}/repo"
  echo "fresh clone of $(git -C "${clone_root}/repo" rev-parse HEAD) in ${clone_root}/repo"
  if [[ -n "$(git -C "${clone_root}/repo" status --porcelain)" ]]; then
    echo "the fresh clone is not clean" >&2
    exit 1
  fi
  # Start from empty Docker volumes every time (only this mode's own "-fresh" resources
  # are removed). The verified compiler archive is reused rather than downloaded again.
  CMSE_DOCKER_PREFIX="${CMSE_DOCKER_PREFIX}-fresh" "${CMSE_REPO_DIR}/scripts/docker/teardown.sh" >/dev/null
  COMPACT_TOOLCHAIN_DIR="${COMPACT_TOOLCHAIN_DIR:-$("${CMSE_REPO_DIR}/scripts/toolchain/fetch-compact.sh")}" \
    CMSE_DOCKER_PREFIX="${CMSE_DOCKER_PREFIX}-fresh" \
    "${clone_root}/repo/scripts/check.sh"
  exit $?
fi

started="$(date +%s)"
echo "== public parameters"
"${CMSE_REPO_DIR}/scripts/docker/fetch-zk-params.sh"
CMSE_ZK_PARAMS=1 "${CMSE_REPO_DIR}/scripts/docker/run.sh" check scripts/check-in-container.sh
echo "== repository (labels over the working tree and the full history; layout)"
"${CMSE_REPO_DIR}/scripts/check-repo.sh" --history
echo "all checks passed in $(($(date +%s) - started)) s"
