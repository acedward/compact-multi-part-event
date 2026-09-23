#!/usr/bin/env bash
# Regenerate vectors/v1.json with the independent Python derivation (vectors/derive.py)
# in a pinned Python image. `--check` fails if the committed file differs.
set -euo pipefail
source "$(dirname "$0")/docker/common.sh"

image="python:3.13-slim@sha256:8d9d0b8bcf6506481eae4907c18f5e3e7902e629f5f6d684f9e7c32e85e3ddf0"
generated="$(docker run --rm --name "${CMSE_DOCKER_PREFIX}-vectors" --network none \
  -v "${CMSE_REPO_DIR}/vectors:/vectors:ro" "${image}" python3 /vectors/derive.py)"
if [[ "${1:-}" == "--check" ]]; then
  if [[ "${generated}" != "$(cat "${CMSE_REPO_DIR}/vectors/v1.json")" ]]; then
    echo "vectors/v1.json differs from vectors/derive.py output" >&2
    exit 1
  fi
  echo "vectors/v1.json matches vectors/derive.py"
else
  printf '%s\n' "${generated}" >"${CMSE_REPO_DIR}/vectors/v1.json"
  echo "wrote vectors/v1.json"
fi
