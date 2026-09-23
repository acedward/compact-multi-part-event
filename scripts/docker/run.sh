#!/usr/bin/env bash
# Run one command in the pinned Node image against a copy of this repository.
#
# Usage: scripts/docker/run.sh <name-suffix> <command...>
#
# The working tree (without .git, node_modules, caches and generated output) is
# copied into the named volume ${CMSE_DOCKER_PREFIX}-work at /work/repo before
# every run, so dependencies and compiler output stay on the Linux filesystem.
# (Bind-mounting the tree with a nested node_modules volume is unreliable under
# Docker Desktop: the nested mount can disappear while the container runs.)
# Generated output inside the volume (node_modules, contracts/managed,
# tests/contracts/managed, examples/consumer/managed, build) survives between runs.
#
# Optional environment:
#   CMSE_EXPORT           space-separated repository-relative paths to copy back
#                         from the volume to the working tree after the command
#   CMSE_DOCKER_NETWORK   Docker network to join (default: bridge)
#   CMSE_DOCKER_ENV       extra "-e NAME=value" arguments (space separated)
#   CMSE_ZK_PARAMS        1 = mount ${CMSE_PARAMS_VOLUME} at /zk-params (MIDNIGHT_PP)
set -euo pipefail
source "$(dirname "$0")/common.sh"

if [[ $# -lt 2 ]]; then
  echo "usage: $0 <name-suffix> <command...>" >&2
  exit 2
fi
suffix="$1"
shift

toolchain_dir="$("${CMSE_REPO_DIR}/scripts/toolchain/fetch-compact.sh")"
for volume in "${CMSE_WORK_VOLUME}" "${CMSE_CACHE_VOLUME}"; do
  docker volume inspect "${volume}" >/dev/null 2>&1 || docker volume create --label "${CMSE_LABEL}" "${volume}" >/dev/null
done

# 1. Copy the working tree into the volume, keeping generated output.
tar_flags=()
if tar --version 2>/dev/null | grep -q bsdtar; then tar_flags+=(--no-mac-metadata --no-xattrs); fi
COPYFILE_DISABLE=1 tar -C "${CMSE_REPO_DIR}" ${tar_flags[@]+"${tar_flags[@]}"} \
  --exclude=./.git --exclude=./node_modules --exclude=./.cache \
  --exclude=./dist --exclude=./build \
  --exclude=./contracts/managed --exclude=./tests/contracts/managed \
  --exclude=./examples/consumer/managed \
  -cf - . |
  docker run --rm -i --label "${CMSE_LABEL}" --name "${CMSE_DOCKER_PREFIX}-sync-in" -v "${CMSE_WORK_VOLUME}:/work" \
    "${CMSE_NODE_IMAGE}" bash -c '
      set -euo pipefail
      mkdir -p /work/repo /work/keep
      cd /work/repo
      for kept in contracts/managed tests/contracts/managed examples/consumer/managed; do
        if [[ -d "${kept}" ]]; then mkdir -p "/work/keep/$(dirname "${kept}")"; mv "${kept}" "/work/keep/${kept}"; fi
      done
      find . -mindepth 1 -maxdepth 1 ! -name node_modules ! -name build ! -name dist \
        -exec rm -rf {} +
      tar -xf -
      find . -name "._*" -delete
      for kept in contracts/managed tests/contracts/managed examples/consumer/managed; do
        if [[ -d "/work/keep/${kept}" ]]; then mkdir -p "$(dirname "${kept}")"; mv "/work/keep/${kept}" "${kept}"; fi
      done
      rm -rf /work/keep'

# 2. Run the command.
extra_args=()
if [[ "${CMSE_ZK_PARAMS:-0}" == "1" ]]; then
  extra_args+=(-v "${CMSE_PARAMS_VOLUME}:/zk-params" -e "MIDNIGHT_PP=/zk-params")
fi
set +e
# shellcheck disable=SC2086 # CMSE_DOCKER_ENV is a list of arguments by design.
docker run --rm --label "${CMSE_LABEL}" --name "${CMSE_DOCKER_PREFIX}-${suffix}" \
  --network "${CMSE_DOCKER_NETWORK:-bridge}" \
  -v "${CMSE_WORK_VOLUME}:/work" \
  -v "${CMSE_CACHE_VOLUME}:/cache" \
  -v "${toolchain_dir}:/toolchain:ro" \
  ${extra_args[@]+"${extra_args[@]}"} \
  -e NPM_CONFIG_CACHE=/cache/npm \
  -e PATH="/toolchain:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  ${CMSE_DOCKER_ENV:-} \
  -w /work/repo \
  "${CMSE_NODE_IMAGE}" \
  bash -c "$*"
status=$?
set -e

# 3. Copy requested outputs back to the working tree.
if [[ -n "${CMSE_EXPORT:-}" ]]; then
  # shellcheck disable=SC2086 # CMSE_EXPORT is a list of paths by design.
  docker run --rm --label "${CMSE_LABEL}" --name "${CMSE_DOCKER_PREFIX}-sync-out" -v "${CMSE_WORK_VOLUME}:/work" \
    "${CMSE_NODE_IMAGE}" bash -c "cd /work/repo && tar -cf - --ignore-failed-read ${CMSE_EXPORT}" |
    tar -C "${CMSE_REPO_DIR}" -xf -
fi
exit "${status}"
