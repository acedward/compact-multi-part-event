#!/usr/bin/env bash
# Fill the ${CMSE_PARAMS_VOLUME} volume with the Midnight public parameters for k = 10..17
# (every circuit here is k <= 17), for key generation and the local proof server.
#
# Source, in order: files already in the volume; CMSE_ZK_PARAMS_DIR (a local cache, e.g.
# ~/.cache/midnight/zk-params); otherwise a download from https://srs.midnight.network/
# into .cache/zk-params/. Every file is checked against the SHA-256 pinned in the
# Midnight ledger's base-crypto/src/data_provider.rs before it is used.
set -euo pipefail
source "$(dirname "$0")/common.sh"

# "<sha256>  <file>" lines (host scripts avoid bash 4 features: macOS ships bash 3.2).
PINNED="46b2290933cbed4c378889e4ba971f1a92888331ffb09466acd4ff61a1e2cb42  bls_midnight_2p10
9901589d7956ff58be0d85569b2f455b77b58c3758026ffb5bbe4807000b96d1  bls_midnight_2p11
ef08eb3fcf62df8f72c515cffa027e681808b530cb016eea104115545ef6d5c8  bls_midnight_2p12
d3324910969c4cc54143b8045b649e5c3a4bd5fb7b8f85fe1b770f640ce1c803  bls_midnight_2p13
fc253016885ec830e97808c9ec920bb5cab5c21af590380a6cb5eb0538e2b244  bls_midnight_2p14
724c7c3d779148bb113c7ee9c034b2f27db16e6bdf315fde90105a9bad00b1de  bls_midnight_2p15
09c877216d6589b370263e18af40a030a901b41a7a7c37ef58c9901db41f05c6  bls_midnight_2p16
4a9ef6c7c0619aab74eede44b13e753e3ba54508a02dd3b7106a949aabb73b74  bls_midnight_2p17"

sums_file="$(mktemp)"
trap 'rm -f "${sums_file}"' EXIT
printf '%s\n' "${PINNED}" >"${sums_file}"

docker volume inspect "${CMSE_PARAMS_VOLUME}" >/dev/null 2>&1 || docker volume create --label "${CMSE_LABEL}" "${CMSE_PARAMS_VOLUME}" >/dev/null
if docker run --rm --label "${CMSE_LABEL}" --name "${CMSE_DOCKER_PREFIX}-params-check" -v "${CMSE_PARAMS_VOLUME}:/zk-params" \
  -v "${sums_file}:/sums:ro" "${CMSE_NODE_IMAGE}" bash -c 'cd /zk-params && sha256sum -c --quiet /sums' \
  >/dev/null 2>&1; then
  echo "public parameters k=10..17 present and verified in ${CMSE_PARAMS_VOLUME}"
  exit 0
fi

source_dir="${CMSE_ZK_PARAMS_DIR:-}"
if [[ -z "${source_dir}" ]]; then
  source_dir="${CMSE_REPO_DIR}/.cache/zk-params"
  mkdir -p "${source_dir}"
  for name in $(printf '%s\n' "${PINNED}" | awk '{ print $2 }'); do
    [[ -f "${source_dir}/${name}" ]] || curl -fsSL -o "${source_dir}/${name}" "https://srs.midnight.network/${name}"
  done
fi
(
  cd "${source_dir}"
  if command -v sha256sum >/dev/null 2>&1; then sha256sum -c --quiet "${sums_file}"; else shasum -a 256 -c --quiet "${sums_file}"; fi
) || {
  echo "public parameters in ${source_dir} do not match the pinned SHA-256 values" >&2
  exit 1
}
CMSE_ZK_PARAMS_DIR="${source_dir}" "$(dirname "$0")/seed-zk-params.sh" 17 >/dev/null
echo "public parameters k=10..17 verified and copied into ${CMSE_PARAMS_VOLUME}"
