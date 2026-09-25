#!/usr/bin/env bash
# Repository check: the label policy and the repository layout (the files version 1
# needs to build, check, use and verify it; nothing else).
#
# 1. The reserved three-letter proposal label in upper case (ASCII bytes 4d 49 50)
#    appears in no path and no file content (binary files included), except the two
#    documents that name the proposal: README.md (the standard's name) and the proposal
#    draft next to it (${DRAFT}), which is named after the label. Commit messages never
#    carry the label.
# 2. The lower-case placeholder of the standard's name appears only in README.md and the
#    proposal draft.
# 3. Every path (tracked, or untracked and not ignored) is one the layout allows, and
#    every required file exists. Generated output (dist/, build/, managed/,
#    node_modules/, .cache/) is ignored by .gitignore and never committed.
#
# Usage: scripts/check-repo.sh            # the working tree
#        scripts/check-repo.sh --history  # also every blob, path and commit message of
#                                         # every ref in the Git history (labels only)
set -euo pipefail
cd "$(dirname "$0")/.."

upper=$'\x4d\x49\x50'
placeholder="$(printf 'mi%s-xxxx' 'p')"
# The proposal draft, named after the label.
DRAFT="${upper}-SPEC-DRAFT.md"
# The documents that name the proposal: the only files that may carry the label.
LABEL_ALLOWED=("README.md" "${DRAFT}")
PLACEHOLDER_ALLOWED=("README.md" "${DRAFT}")

# The layout: fixed files (all required) ...
FIXED=(
  README.md
  "${DRAFT}"
  LICENSE
  package.json
  package-lock.json
  .npmrc
  tsconfig.json
  tsconfig.build.json
  eslint.config.js
  .prettierrc.json
  .prettierignore
  vitest.config.ts
  .gitignore
  .github/workflows/check.yml
  contract-examples/whitelist/EmitterWhitelist.compact
  contract-examples/whitelist/whitelist.ts
  contract-examples/emitter/emitter.compact
  contract-examples/emitter/keys/SHA256SUMS
  contract-examples/notice-board/notice-board.compact
  contract-examples/notice-board/keys/SHA256SUMS
  contract-examples/notice-board/package.json
  contract-examples/notice-board/tsconfig.build.json
  tests/contracts/open-emitter.compact
  scripts/check.sh
  scripts/check-in-container.sh
  scripts/check-repo.sh
  scripts/check-pins.mjs
  scripts/check-external-consumer.sh
  scripts/compile-contracts.sh
  scripts/keys.sh
  scripts/docker/run.sh
  scripts/docker/common.sh
  scripts/docker/teardown.sh
  scripts/docker/proof-server.sh
  scripts/docker/fetch-zk-params.sh
  scripts/docker/seed-zk-params.sh
  scripts/toolchain/fetch-compact.sh
)
# ... and the directories whose files follow a pattern (one level, no subdirectories).
PATTERNS=(
  '^contract-examples/(emitter|notice-board)/keys/[A-Za-z0-9_]+\.verifier$'
  '^contract-examples/notice-board/src/[a-z0-9-]+\.ts$'
  '^src/(reader|publisher|indexer|cli)/[a-z0-9-]+\.ts$'
  '^deploy-tools/[a-z0-9-]+\.ts$'
  '^tests/[a-z0-9-]+\.test\.ts$'
  '^tests/helpers/[a-z0-9-]+\.ts$'
)
# Files the patterns must also yield.
REQUIRED=(
  contract-examples/emitter/keys/emitPart.verifier
  contract-examples/notice-board/keys/emitPart.verifier
  contract-examples/notice-board/src/board.ts
  contract-examples/notice-board/src/offline-demo.ts
  src/reader/index.ts
  src/publisher/index.ts
  src/indexer/index.ts
  src/cli/main.ts
  deploy-tools/main.ts
)

status=0
files=()
while IFS= read -r -d '' file; do
  [[ -f "${file}" ]] && files+=("${file}")
done < <(git ls-files -z --cached --others --exclude-standard)

label_allowed() {
  local file="$1" name
  for name in "${LABEL_ALLOWED[@]}"; do [[ "${file}" == "${name}" ]] && return 0; done
  return 1
}

in_layout() {
  local file="$1" fixed pattern
  for fixed in "${FIXED[@]}"; do [[ "${file}" == "${fixed}" ]] && return 0; done
  for pattern in "${PATTERNS[@]}"; do [[ "${file}" =~ ${pattern} ]] && return 0; done
  return 1
}

for file in "${files[@]}"; do
  if ! in_layout "${file}"; then
    echo "outside the repository layout: ${file}" >&2
    status=1
  fi
  if ! label_allowed "${file}"; then
    if [[ "${file}" == *"${upper}"* ]]; then
      echo "reserved label in path: ${file}" >&2
      status=1
    fi
    if LC_ALL=C grep -q -a -F -- "${upper}" "${file}"; then
      echo "reserved label in content: ${file}" >&2
      status=1
    fi
  fi
  if LC_ALL=C grep -q -a -F -- "${placeholder}" "${file}"; then
    allowed=0
    for name in "${PLACEHOLDER_ALLOWED[@]}"; do [[ "${file}" == "${name}" ]] && allowed=1; done
    if [[ "${allowed}" -eq 0 ]]; then
      echo "name placeholder outside ${PLACEHOLDER_ALLOWED[*]}: ${file}" >&2
      status=1
    fi
  fi
done
for file in "${FIXED[@]}" "${REQUIRED[@]}"; do
  if [[ ! -f "${file}" ]]; then
    echo "missing from the repository layout: ${file}" >&2
    status=1
  fi
done

blobs=0
if [[ "${1:-}" == "--history" ]] && git rev-parse --verify HEAD >/dev/null 2>&1; then
  while read -r object type path; do
    [[ "${type}" == "blob" ]] || continue
    blobs=$((blobs + 1))
    label_allowed "${path}" && continue
    if git cat-file blob "${object}" | LC_ALL=C grep -q -a -F -- "${upper}"; then
      echo "reserved label in history blob ${object} (${path})" >&2
      status=1
    fi
    if [[ "${path}" == *"${upper}"* ]]; then
      echo "reserved label in history path: ${path}" >&2
      status=1
    fi
  done < <(git rev-list --objects --all |
    git cat-file --batch-check='%(objectname) %(objecttype) %(rest)')
  if git log --all --format='%an %ae %cn %ce %B' | LC_ALL=C grep -q -a -F -- "${upper}"; then
    echo "reserved label in commit metadata" >&2
    status=1
  fi
fi

if [[ "${status}" -eq 0 ]]; then
  echo "repository check passed: ${#files[@]} files in the layout, labels clean${1:+ (history: ${blobs} blobs, $(git rev-list --all | wc -l | tr -d ' ') commits)}"
fi
exit "${status}"
