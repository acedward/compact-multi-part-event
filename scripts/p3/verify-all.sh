#!/usr/bin/env bash
# P3.8: wallet-free re-verification of every live publication, run in a FRESH container
# from a clean clone (no wallet, no secret, no CMSE_* variable). Each command's output and
# exit status are saved; nothing here needs signing material.
#
# usage (inside the clone, after `npm ci && npm run build`; the recorded run used the
# Yarn equivalents at c4b9b75, before the repository moved to npm):
#   scripts/p3/verify-all.sh <out dir> [<saved evidence dir for the offline checks>]
set -uo pipefail
out="${1:?usage: verify-all.sh <out dir> [<evidence dir>]}"
evidence="${2:-}"
mkdir -p "${out}"
node_url="https://rpc.stagenet.shielded.tools"
emitter="6240fbd956523c6f9a2feb78c0e72e63fba53a03486c5deac8c346ce51d23436"
consumer="cf12a32260fd443d0c1d6fce6316bd420fe850a278076e872834e35016c8d7ef"

run() {
  local label="$1"
  shift
  {
    echo "\$ cmse $*"
    node dist/cli/main.js "$@"
    echo "exit status $?"
  } >"${out}/${label}.log" 2>&1
  node dist/cli/main.js "$@" --json >"${out}/${label}.json" 2>/dev/null
  tail -n 2 "${out}/${label}.log" | tr '\n' ' '
  echo "[${label}]"
}

env | grep -c '^CMSE_' | sed 's/^/CMSE_* variables set: /'
run m1 verify --contract "${emitter}" --tx 79c26aa9153e09494f6db3a765130a0ced6e657d55ac2e72881b6007b0afca5e --level 3 --node "${node_url}"
run m2 verify --contract "${emitter}" --tx 87b04195c1e2812d2060aee1c879e64cd9b1ae98bc62443f774799b64ed6db65 --level 3 --node "${node_url}"
run m3 verify --contract "${emitter}" --tx 65656150ece3f1d0673f543eeca2cdadd8bac52cb84a6b5ddfe62a1c4e21a45a --level 3 --node "${node_url}"
run q26-merged-both verify --contract "${emitter}" --tx 7e8407de37393a2bbeeb005fd744335a5766f5cdcb00210c2d823cf842cd5230 --level 3 --node "${node_url}"
run q26-a verify --contract "${emitter}" --tx 7e8407de37393a2bbeeb005fd744335a5766f5cdcb00210c2d823cf842cd5230 --request-id 6ff74e5a262bd534ef108906bcf59d02b0f8620934906a16353d5e71258e5cdc --level 3 --node "${node_url}"
run q26-b verify --contract "${emitter}" --tx 7e8407de37393a2bbeeb005fd744335a5766f5cdcb00210c2d823cf842cd5230 --request-id d1c7aa4661fb30f33a3a6b9567eb2e5f62b0976b6e4ed73d0b60ba457b53ea4c --level 3 --node "${node_url}"
run consumer-m1 verify --kind consumer --contract "${consumer}" --tx 7eab20e01e9a1cec3c44fa145282ff6eab409a115c485e46ddec3b48099e9de4 --level 3 --node "${node_url}"
# Contract scope: M1's transaction holds no events of the consumer (expect exit 3).
run negative-m1-tx-at-consumer verify --kind consumer --contract "${consumer}" --tx 79c26aa9153e09494f6db3a765130a0ced6e657d55ac2e72881b6007b0afca5e --level 3
# Offline, from the saved raw bytes and the saved contract state (no network).
if [[ -n "${evidence}" ]]; then
  run offline-m1 verify --contract "${emitter}" --raw-file "${evidence}/transactions/79c26aa9153e09494f6db3a765130a0ced6e657d55ac2e72881b6007b0afca5e.hex" --tx 79c26aa9153e09494f6db3a765130a0ced6e657d55ac2e72881b6007b0afca5e --status SUCCESS --state-file "${evidence}/contracts/emitter-state-after-deploy.hex" --level 3
  run offline-m2 verify --contract "${emitter}" --raw-file "${evidence}/transactions/87b04195c1e2812d2060aee1c879e64cd9b1ae98bc62443f774799b64ed6db65.hex" --tx 87b04195c1e2812d2060aee1c879e64cd9b1ae98bc62443f774799b64ed6db65 --status SUCCESS --state-file "${evidence}/contracts/emitter-state-after-deploy.hex" --level 3
  run offline-q26 verify --contract "${emitter}" --raw-file "${evidence}/transactions/7e8407de37393a2bbeeb005fd744335a5766f5cdcb00210c2d823cf842cd5230.hex" --tx 7e8407de37393a2bbeeb005fd744335a5766f5cdcb00210c2d823cf842cd5230 --status SUCCESS --state-file "${evidence}/contracts/emitter-state-after-deploy.hex" --level 3
  run offline-consumer-m1 verify --kind consumer --contract "${consumer}" --raw-file "${evidence}/transactions/7eab20e01e9a1cec3c44fa145282ff6eab409a115c485e46ddec3b48099e9de4.hex" --tx 7eab20e01e9a1cec3c44fa145282ff6eab409a115c485e46ddec3b48099e9de4 --status SUCCESS --state-file "${evidence}/contracts/consumer-state-after-deploy.hex" --level 3
fi
