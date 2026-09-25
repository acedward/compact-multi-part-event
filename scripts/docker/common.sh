#!/usr/bin/env bash
# Shared settings for the containerized repository commands. Source it; do not run it.
#
# Every Docker resource these scripts create is named with the prefix
# ${CMSE_DOCKER_PREFIX} (default "cmse") and carries the label ${CMSE_LABEL}, and
# scripts/docker/teardown.sh removes exactly those resources: by label or exact name,
# never by a name prefix, so another prefix that starts with this one (cmse-live-* for the
# default cmse) is left alone.

CMSE_REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
CMSE_DOCKER_PREFIX="${CMSE_DOCKER_PREFIX:-cmse}"

# node:24-bookworm-slim, multi-arch index digest (Node v24.21.0 with its bundled npm 11.19.0,
# the repository's package manager).
CMSE_NODE_IMAGE="${CMSE_NODE_IMAGE:-node:24-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553}"

# Local proof service (opt-in real-proof test, and the proof server deploy-tools talks to).
# 9.0.0-rc.6 proves ZKIR v3 and carries the dust/9 keys today's stagenet node expects
# (multi-arch index digest).
CMSE_PROOF_IMAGE="${CMSE_PROOF_IMAGE:-midnightntwrk/proof-server:9.0.0-rc.6@sha256:38a819eacde273f725551fdf90ca7c31ebf3c0ff145f3ed58ee35f92fb7ce95b}"

CMSE_WORK_VOLUME="${CMSE_DOCKER_PREFIX}-work"
CMSE_CACHE_VOLUME="${CMSE_DOCKER_PREFIX}-cache"
CMSE_PARAMS_VOLUME="${CMSE_DOCKER_PREFIX}-zk-params"
CMSE_NETWORK="${CMSE_DOCKER_PREFIX}-net"
CMSE_PROOF_CONTAINER="${CMSE_DOCKER_PREFIX}-proof-server"
CMSE_LABEL="cmse.prefix=${CMSE_DOCKER_PREFIX}"

# Architecture of the Docker engine, in Compact release naming (aarch64 / x86_64).
cmse_engine_arch() {
  case "$(docker version --format '{{.Server.Arch}}')" in
    arm64 | aarch64) echo "aarch64" ;;
    amd64 | x86_64) echo "x86_64" ;;
    *)
      echo "unsupported Docker engine architecture" >&2
      return 1
      ;;
  esac
}
