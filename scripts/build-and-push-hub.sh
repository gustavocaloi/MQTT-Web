#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Uso:
  ./scripts/build-and-push-hub.sh <imagem> [tag] [--latest] [--no-cache] [--prune]

Exemplos:
  ./scripts/build-and-push-hub.sh lcaloi/expertiseai
  ./scripts/build-and-push-hub.sh lcaloi/expertiseai beta
  ./scripts/build-and-push-hub.sh lcaloi/expertiseai beta --latest
  ./scripts/build-and-push-hub.sh lcaloi/expertiseai --no-cache
  ./scripts/build-and-push-hub.sh lcaloi/expertiseai --prune
  ./scripts/build-and-push-hub.sh lcaloi/expertiseai --no-cache --prune
  TAG_PUBLISH=beta ./scripts/build-and-push-hub.sh lcaloi/expertiseai
  Sem tag informada, usa a data atual automaticamente.

Requer:
  - docker instalado e autenticado no Docker Hub (docker login)
  - Dockerfile na raiz do projeto

Flags:
  --latest    Publica tambem a tag latest.
  --no-cache  Faz build sem cache do Docker.
  --prune     Faz limpeza dos caches antes do buildx para reduzir falhas por falta de espaço.
EOF
}

if [ "$#" -lt 1 ]; then
  usage
  exit 1
fi

IMAGE="$1"
shift

NO_CACHE_FLAG=""
DO_PRUNE=0
PUBLISH_LATEST=0
TAG="${TAG_PUBLISH:-}"

while [ "$#" -gt 0 ]; do
  case "${1:-}" in
    --no-cache)
      NO_CACHE_FLAG="--no-cache"
      ;;
    --prune)
      DO_PRUNE=1
      ;;
    --latest)
      PUBLISH_LATEST=1
      ;;
    --*)
      echo "Flag inválida: $1"
      usage
      exit 1
      ;;
    *)
      if [ -n "$TAG" ]; then
        echo "Tag informada mais de uma vez: $1"
        usage
        exit 1
      fi
      TAG="$1"
      ;;
  esac
  shift
done

PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
TAG="${TAG:-$(date +%Y.%m.%d)}"

if [[ "$IMAGE" == *:* ]]; then
  echo "Informe a imagem sem tag. Use: $0 ${IMAGE%%:*} ${IMAGE#*:}"
  exit 1
fi

if [[ ! "$TAG" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]]; then
  echo "Tag inválida: $TAG"
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [ ! -f Dockerfile ]; then
  echo "Dockerfile não encontrado em $ROOT_DIR"
  exit 1
fi

if ! docker buildx inspect multiarch >/dev/null 2>&1; then
  echo "Criando builder 'multiarch'..."
  docker buildx create --name multiarch --use >/dev/null
fi

docker buildx use multiarch >/dev/null
docker buildx inspect --bootstrap multiarch >/dev/null

if [ "$DO_PRUNE" -eq 1 ]; then
  echo "Limpando caches locais antes do build..."
  docker builder prune -f >/dev/null
  docker buildx prune -f --builder multiarch >/dev/null
  docker system prune -f >/dev/null
fi

echo "Buildx build e push multi-plataforma: ${PLATFORMS}"
BUILD_TAGS=(--tag "${IMAGE}:${TAG}")
if [ "$PUBLISH_LATEST" -eq 1 ]; then
  BUILD_TAGS+=(--tag "${IMAGE}:latest")
fi

docker buildx build \
  --platform "${PLATFORMS}" \
  ${NO_CACHE_FLAG} \
  --provenance=false \
  --sbom=false \
  --file Dockerfile \
  "${BUILD_TAGS[@]}" \
  --push \
  .

echo "OK. Publicado em Docker Hub:"
echo "  - ${IMAGE}:${TAG}"
if [ "$PUBLISH_LATEST" -eq 1 ]; then
  echo "  - ${IMAGE}:latest"
fi
