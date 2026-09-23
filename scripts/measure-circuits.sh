#!/usr/bin/env bash
# Print circuit size (k, rows, table rows) for every compiled ZKIR v3 circuit with
# `zkir-v3 mock-compile -v`, which models a circuit without generating keys.
# Run `npm run compile` first. Values from compactc 0.34.0 are provisional.
# k >= 19 is the documented trigger for evaluating an optimized (MinoCrab) circuit.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "# compactc $(compactc --version) --feature-zkir-v3 --skip-zk; zkir-v3 $(zkir-v3 --version | awk '{print $2}') mock-compile -v"
printf 'contract\tcircuit\tk\trows\ttable_rows\n'
for zkir in contracts/managed/*/zkir/*.zkir examples/consumer/managed/*/zkir/*.zkir tests/contracts/managed/*/zkir/*.zkir; do
  contract="$(basename "$(dirname "$(dirname "${zkir}")")")"
  model="$(zkir-v3 mock-compile -v "${zkir}" 2>&1 | grep -o 'CircuitModel {[^}]*}')"
  field() { echo "${model}" | grep -o "$1: [0-9]*" | head -1 | awk '{print $2}'; }
  printf '%s\t%s\t%s\t%s\t%s\n' "${contract}" "$(basename "${zkir}" .zkir)" "$(field k)" "$(field rows)" "$(field table_rows)"
done
