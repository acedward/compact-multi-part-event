#!/usr/bin/env bash
# Remove every Docker resource named with ${CMSE_DOCKER_PREFIX}- and show that none remain.
# It never touches resources with other names.
set -euo pipefail
source "$(dirname "$0")/common.sh"

prefix="${CMSE_DOCKER_PREFIX}-"
for container in $(docker ps -a --filter "name=^${prefix}" --format '{{.Names}}'); do
  docker rm -f "${container}" >/dev/null && echo "removed container ${container}"
done
for network in $(docker network ls --filter "name=^${prefix}" --format '{{.Name}}'); do
  docker network rm "${network}" >/dev/null && echo "removed network ${network}"
done
for volume in $(docker volume ls --filter "name=^${prefix}" --format '{{.Name}}'); do
  docker volume rm "${volume}" >/dev/null && echo "removed volume ${volume}"
done

echo "--- remaining ${prefix}* resources (expect none)"
docker ps -a --filter "name=^${prefix}" --format 'container {{.Names}}'
docker volume ls --filter "name=^${prefix}" --format 'volume {{.Name}}'
docker network ls --filter "name=^${prefix}" --format 'network {{.Name}}'
