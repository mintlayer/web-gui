#!/usr/bin/env bash
# Build mintlayer-core Docker images from local source.
# Run from the web-gui directory; mintlayer-core must be at ../mintlayer-core.
#
# Usage:
#   ./build-core-images.sh              # build all images
#   ./build-core-images.sh --no-cache   # force a full rebuild
#   ./build-core-images.sh node-daemon wallet-rpc-daemon   # build specific images

set -euo pipefail

NO_CACHE=""
TARGETS=()

# Parse arguments (flags and optional service names only; path comes from prompt)
for arg in "$@"; do
  if [[ "$arg" == "--no-cache" ]]; then
    NO_CACHE="--no-cache"
  else
    TARGETS+=("$arg")
  fi
done

# ── Prompt for the mintlayer-core source directory ────────────────────────────
DEFAULT_CORE_DIR="$(cd "$(dirname "$0")/../mintlayer-core" 2>/dev/null && pwd || true)"

if [[ -n "$DEFAULT_CORE_DIR" && -d "$DEFAULT_CORE_DIR" ]]; then
  read -rp "mintlayer-core source directory [$DEFAULT_CORE_DIR]: " INPUT_DIR
  CORE_DIR="${INPUT_DIR:-$DEFAULT_CORE_DIR}"
else
  read -rp "mintlayer-core source directory: " CORE_DIR
fi

# Expand ~ manually since read doesn't do it
CORE_DIR="${CORE_DIR/#\~/$HOME}"
CORE_DIR="$(cd "$CORE_DIR" && pwd)"

if [[ ! -d "$CORE_DIR" ]]; then
  echo "Error: directory not found: $CORE_DIR" >&2
  exit 1
fi

if [[ ! -f "$CORE_DIR/Cargo.toml" ]]; then
  echo "Error: $CORE_DIR does not look like a mintlayer-core repo (no Cargo.toml)" >&2
  exit 1
fi

DOCKER_DIR="$CORE_DIR/build-tools/docker"

build() {
  local name="$1"   # image tag
  local file="$2"   # Dockerfile path relative to DOCKER_DIR
  echo ""
  echo "==> Building $name"
  # Build context is always the repo root so entrypoint.sh path resolves
  docker build $NO_CACHE -f "$DOCKER_DIR/$file" -t "$name" "$CORE_DIR"
}

# ── Step 1: shared base images (must exist before any service image) ──────────
build "mintlayer-builder:latest"     "Dockerfile.builder"
build "mintlayer-runner-base:latest" "Dockerfile.runner-base"

# ── Step 2: per-service images ────────────────────────────────────────────────
ALL_SERVICES=(
  "mintlayer/node-daemon:latest                Dockerfile.node-daemon"
  "mintlayer/wallet-rpc-daemon:latest          Dockerfile.wallet-rpc-daemon"
  "mintlayer/wallet-cli:latest                 Dockerfile.wallet-cli"
  "mintlayer/api-blockchain-scanner-daemon:latest  Dockerfile.api-blockchain-scanner-daemon"
  "mintlayer/api-web-server:latest             Dockerfile.api-web-server"
)

for entry in "${ALL_SERVICES[@]}"; do
  tag=$(echo "$entry" | awk '{print $1}')
  file=$(echo "$entry" | awk '{print $2}')
  # Strip the "mintlayer/" prefix and ":latest" suffix for matching
  short="${tag#mintlayer/}"
  short="${short%:latest}"

  if [[ ${#TARGETS[@]} -eq 0 ]] || [[ " ${TARGETS[*]} " == *" $short "* ]]; then
    build "$tag" "$file"
  fi
done

echo ""
echo "Done. Images are tagged identically to Docker Hub — docker compose up will use them."
