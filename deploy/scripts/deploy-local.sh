#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT_DIR}"

COMPOSE=(docker compose -f "${ROOT_DIR}/deploy/docker-compose.yml")
if [ -f "${ROOT_DIR}/.env" ]; then
  COMPOSE+=(--env-file "${ROOT_DIR}/.env")
fi

docker info >/dev/null
"${COMPOSE[@]}" config --quiet
echo "Construindo e iniciando MQTT Web..."
"${COMPOSE[@]}" up -d --build --wait mqtt-web

PUBLISHED_ADDRESS="$("${COMPOSE[@]}" port mqtt-web 8080)"
PUBLISHED_PORT="${PUBLISHED_ADDRESS##*:}"
echo "Aplicacao: http://localhost:${PUBLISHED_PORT}"
echo "Health: http://localhost:${PUBLISHED_PORT}/health"
