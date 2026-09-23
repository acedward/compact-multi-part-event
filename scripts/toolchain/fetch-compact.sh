#!/usr/bin/env bash
# Print the directory of a verified Linux Compact 0.34.0 toolchain for the Docker
# engine's architecture, downloading and checking the official release archive
# into .cache/compact/ when needed.
#
# COMPACT_TOOLCHAIN_DIR may point at an already unpacked, verified toolchain
# directory (it must contain compactc.bin and zkir-v3).
#
# Checksums are the SHA-256 digests GitHub publishes for the release assets of
# https://github.com/LFDT-Minokawa/compact/releases/tag/compactc-v0.34.0
set -euo pipefail
source "$(dirname "$0")/../docker/common.sh"

version="0.34.0"
if [[ -n "${COMPACT_TOOLCHAIN_DIR:-}" ]]; then
  for file in compactc.bin zkir-v3; do
    [[ -x "${COMPACT_TOOLCHAIN_DIR}/${file}" ]] || {
      echo "COMPACT_TOOLCHAIN_DIR has no executable ${file}" >&2
      exit 1
    }
  done
  echo "${COMPACT_TOOLCHAIN_DIR}"
  exit 0
fi

arch="$(cmse_engine_arch)"
case "${arch}" in
  aarch64) sha256="d3e292c4f48e257dcd6b3d3e3e4743d7d8ea0729f48953eab91a366d44cd026d" ;;
  x86_64) sha256="775ccddf5a71399835329bbf7471ba5a8c54fcc825d372c75e19ba7042069584" ;;
esac
asset="compactc_v${version}_${arch}-unknown-linux-musl.zip"
url="https://github.com/LFDT-Minokawa/compact/releases/download/compactc-v${version}/${asset}"
target="${CMSE_REPO_DIR}/.cache/compact/${version}/${arch}"

if [[ ! -x "${target}/compactc.bin" || ! -x "${target}/zkir-v3" ]]; then
  mkdir -p "${target}"
  archive="${target}/${asset}"
  curl -fsSL -o "${archive}" "${url}"
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "${archive}" | cut -d' ' -f1)"
  else
    actual="$(shasum -a 256 "${archive}" | cut -d' ' -f1)"
  fi
  if [[ "${actual}" != "${sha256}" ]]; then
    rm -f "${archive}"
    echo "checksum mismatch for ${asset}: ${actual} != ${sha256}" >&2
    exit 1
  fi
  unzip -q -o "${archive}" -d "${target}"
  rm -f "${archive}"
fi
echo "${target}"
