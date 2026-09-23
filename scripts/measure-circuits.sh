#!/usr/bin/env bash
# Circuit evidence for every compiled ZKIR v3 circuit (run `yarn compile` first):
#   evidence/circuits/k-rows.tsv          k, rows, table rows and column counts
#   evidence/circuits/mock-compile.log    the raw `zkir-v3 mock-compile -v` model lines
#   evidence/circuits/pure-emit-fixture.log
#                                         compiler output proving that a `pure`
#                                         circuit calling the emission logic is rejected
# `zkir-v3 mock-compile` models a circuit without generating keys. k >= 19 is the
# documented trigger for evaluating an optimized (MinoCrab) implementation.
set -euo pipefail
cd "$(dirname "$0")/.."

dir="evidence/circuits"
mkdir -p "${dir}"
header="# compactc $(compactc --version) --feature-zkir-v3 --skip-zk (runtime $(compactc --runtime-version), $(compactc --ledger-version)); zkir-v3 $(zkir-v3 --version | awk '{print $2}') mock-compile -v"
strip() { sed -e 's/\x1b\[[0-9;]*m//g' -e 's/^[0-9TZ:.-]* *//'; }

{
  echo "${header}"
  printf 'contract\tcircuit\tk\trows\ttable_rows\tadvice_columns\tfixed_columns\tlookups\n'
} >"${dir}/k-rows.tsv"
echo "${header}" >"${dir}/mock-compile.log"
for zkir in contracts/managed/*/zkir/*.zkir tests/contracts/managed/*/zkir/*.zkir; do
  contract="$(basename "$(dirname "$(dirname "${zkir}")")")"
  circuit="$(basename "${zkir}" .zkir)"
  output="$(zkir-v3 mock-compile -v "${zkir}" 2>&1 | strip)"
  echo "${output}" >>"${dir}/mock-compile.log"
  model="$(echo "${output}" | grep -o 'CircuitModel {[^}]*}')"
  field() { echo "${model}" | grep -o "$1: [0-9]*" | head -1 | awk '{print $2}'; }
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "${contract}" "${circuit}" "$(field k)" "$(field rows)" \
    "$(field table_rows)" "$(field advice_columns)" "$(field fixed_columns)" "$(field lookups)" \
    >>"${dir}/k-rows.tsv"
done

fixture="tests/contracts/fixtures/pure-emit.compact"
fixture_out="$(mktemp -d)"
{
  echo "# compactc $(compactc --version) --feature-zkir-v3 --skip-zk ${fixture} <tmp>"
  if compactc --feature-zkir-v3 --skip-zk "${fixture}" "${fixture_out}" 2>&1; then
    echo "UNEXPECTED: the fixture compiled"
  else
    echo "# exit status: non-zero (expected)"
  fi
} | sed "s|${fixture_out}|<tmp>|g" >"${dir}/pure-emit-fixture.log"
rm -rf "${fixture_out}"
grep -q "UNEXPECTED" "${dir}/pure-emit-fixture.log" && { echo "pure-emit fixture compiled" >&2; exit 1; }

cat "${dir}/k-rows.tsv"
echo "--- ${dir}/pure-emit-fixture.log"
cat "${dir}/pure-emit-fixture.log"
