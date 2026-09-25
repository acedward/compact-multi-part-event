#!/usr/bin/env bash
# The secret-free check sequence, run INSIDE the pinned Node image by scripts/check.sh.
# Needs the Compact toolchain on PATH and the public parameters at MIDNIGHT_PP.
set -euo pipefail
cd "$(dirname "$0")/.."

started="$(date +%s)"
step() {
  local name="$1"
  shift
  local begin
  begin="$(date +%s)"
  echo "== ${name}"
  "$@"
  echo "-- ${name}: ok ($(($(date +%s) - begin)) s)"
}

step "install (npm ci, from package-lock.json)" npm ci
step "dependency pins (one copy each)" node scripts/check-pins.mjs
step "compile (skip-zk: 2 examples, 1 test contract)" npm run compile
step "keys (regenerate, compare committed hashes)" scripts/keys.sh verify all
step "format" npm run format:check
step "lint (type-aware)" npm run lint
step "typecheck" npm run typecheck
step "build" npm run build
step "tests" npm test
step "external consumer" scripts/check-external-consumer.sh
echo "container checks passed in $(($(date +%s) - started)) s"
