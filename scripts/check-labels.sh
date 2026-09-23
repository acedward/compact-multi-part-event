#!/usr/bin/env bash
# Repository label policy check.
#
# 1. The reserved three-letter proposal label in upper case (ASCII bytes 4d 49 50)
#    must not appear in any tracked or to-be-tracked path or file content
#    (binary files included).
# 2. The lower-case event-name placeholder may appear only in files that define
#    or check the event-name prefix (see ALLOWED below).
#
# Usage: scripts/check-labels.sh            # working tree (tracked + untracked, not ignored)
#        scripts/check-labels.sh --history  # also every blob in the full Git history
set -euo pipefail
cd "$(dirname "$0")/.."

upper=$'\x4d\x49\x50'
placeholder="$(printf 'mi%s-xxxx' 'p')"
ALLOWED=(
  "contracts/modules/MultiSegmentEmit.compact"
  "src/codec/constants.ts"
  "tests/"
  "vectors/"
  "README.md"
  "docs/"
)

status=0
files=()
while IFS= read -r -d '' file; do
  [[ -f "${file}" ]] && files+=("${file}")
done < <(git ls-files -z --cached --others --exclude-standard)

for file in "${files[@]}"; do
  if [[ "${file}" == *"${upper}"* ]]; then
    echo "reserved label in path: ${file}" >&2
    status=1
  fi
  if LC_ALL=C grep -q -a -F -- "${upper}" "${file}"; then
    echo "reserved label in content: ${file}" >&2
    status=1
  fi
  if LC_ALL=C grep -q -a -F -- "${placeholder}" "${file}"; then
    allowed=0
    for prefix in "${ALLOWED[@]}"; do
      if [[ "${prefix}" == */ && "${file}" == "${prefix}"* ]] || [[ "${file}" == "${prefix}" ]]; then
        allowed=1
      fi
    done
    if [[ "${allowed}" -eq 0 ]]; then
      echo "event-name placeholder outside the allowed files: ${file}" >&2
      status=1
    fi
  fi
done

if [[ "${1:-}" == "--history" ]]; then
  if git rev-parse --verify HEAD >/dev/null 2>&1; then
    while read -r object path; do
      if git cat-file blob "${object}" | LC_ALL=C grep -q -a -F -- "${upper}"; then
        echo "reserved label in history blob ${object} (${path})" >&2
        status=1
      fi
      if [[ "${path}" == *"${upper}"* ]]; then
        echo "reserved label in history path: ${path}" >&2
        status=1
      fi
    done < <(git rev-list --objects --all | awk 'NF == 2 { print $1, $2 }' |
      while read -r object path; do
        [[ "$(git cat-file -t "${object}")" == "blob" ]] && echo "${object} ${path}"
      done)
    if git log --all --format='%an %ae %cn %ce %B' | LC_ALL=C grep -q -a -F -- "${upper}"; then
      echo "reserved label in commit metadata" >&2
      status=1
    fi
  fi
fi

if [[ "${status}" -eq 0 ]]; then
  echo "label check passed (${#files[@]} files${1:+, $1})"
fi
exit "${status}"
