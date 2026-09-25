#!/usr/bin/env bash
# Remove the Docker resources these scripts create for ${CMSE_DOCKER_PREFIX} and for its
# `check.sh --fresh-clone` companion ${CMSE_DOCKER_PREFIX}-fresh, and show that none remain.
# Resources are matched by the label they carry (cmse.prefix=<prefix>) or by their exact
# names, never by a name prefix: resources of another prefix, even one that starts with
# this one (cmse-live-* for the default cmse), are never touched.
set -euo pipefail
source "$(dirname "$0")/common.sh"

prefixes=("${CMSE_DOCKER_PREFIX}" "${CMSE_DOCKER_PREFIX}-fresh")

# Prints the IDs of one prefix's resources of one kind (container, network, volume):
# the labelled ones, plus those with the exact names these scripts give that kind.
owned() {
  local kind="$1" prefix="$2" name format='{{.Id}}'
  local -a names=()
  case "${kind}" in
    container) names=("${prefix}-proof-server") ;;
    network) names=("${prefix}-net") ;;
    volume) names=("${prefix}-work" "${prefix}-cache" "${prefix}-zk-params") format='{{.Name}}' ;;
  esac
  {
    case "${kind}" in
      container) docker ps -aq --no-trunc --filter "label=cmse.prefix=${prefix}" ;;
      network) docker network ls -q --no-trunc --filter "label=cmse.prefix=${prefix}" ;;
      volume) docker volume ls -q --filter "label=cmse.prefix=${prefix}" ;;
    esac
    for name in "${names[@]}"; do
      docker "${kind}" inspect --format "${format}" "${name}" 2>/dev/null || true
    done
  } | sort -u
}

name_of() {
  docker "$1" inspect --format '{{.Name}}' "$2" | sed 's#^/##'
}

for prefix in "${prefixes[@]}"; do
  for id in $(owned container "${prefix}"); do
    name="$(name_of container "${id}")"
    docker rm -f "${id}" >/dev/null && echo "removed container ${name}"
  done
  for id in $(owned network "${prefix}"); do
    name="$(name_of network "${id}")"
    docker network rm "${id}" >/dev/null && echo "removed network ${name}"
  done
  for id in $(owned volume "${prefix}"); do
    docker volume rm "${id}" >/dev/null && echo "removed volume ${id}"
  done
done

echo "--- remaining resources of ${prefixes[*]} (expect none)"
for prefix in "${prefixes[@]}"; do
  for kind in container network volume; do
    for id in $(owned "${kind}" "${prefix}"); do
      echo "${kind} $(name_of "${kind}" "${id}")"
    done
  done
done
