#!/usr/bin/env bash
# uninstall.sh — Remove all Mintlayer containers, images, and data
#
# Usage:
#   ./tools/uninstall.sh           # interactive, asks before each destructive step
#   ./tools/uninstall.sh --yes     # non-interactive, removes everything
#   ./tools/uninstall.sh --docker  # also uninstall Docker engine (requires root)
#   ./tools/uninstall.sh --yes --docker

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Colors & symbols ──────────────────────────────────────────────────────────
RESET=$'\033[0m'
BOLD=$'\033[1m'
CYAN=$'\033[36m'
GREEN=$'\033[32m'
YELLOW=$'\033[33m'
RED=$'\033[31m'
GRAY=$'\033[90m'

step()    { printf "\n${CYAN}◆${RESET} ${BOLD}%s${RESET}\n" "$*"; }
ok()      { printf "${GREEN}◈${RESET} %s\n" "$*"; }
warn()    { printf "${YELLOW}▲${RESET}  %s\n" "$*"; }
err()     { printf "${RED}✗${RESET}  %s\n" "$*" >&2; }
divider() { printf "${GRAY}└─────────────────────────────────────────${RESET}\n"; }

YES=false
REMOVE_DOCKER=false
for arg in "$@"; do
  case "$arg" in
    --yes)    YES=true ;;
    --docker) REMOVE_DOCKER=true ;;
  esac
done

confirm() {
  # confirm <prompt> — returns 0 if yes, 1 if no
  if $YES; then return 0; fi
  printf "${YELLOW}▲${RESET}  %s ${GRAY}[y/N]${RESET} " "$1"
  read -r answer
  [[ "$answer" =~ ^[Yy]$ ]]
}

# ── Sanity check ──────────────────────────────────────────────────────────────
if ! command -v docker &>/dev/null; then
  err "docker not found — nothing to uninstall."
  exit 1
fi

if $REMOVE_DOCKER && [[ "$EUID" -ne 0 ]]; then
  err "--docker requires root. Re-run with: sudo $0 $*"
  exit 1
fi

printf "\n${BOLD}Mintlayer — Uninstaller${RESET}\n"
printf "${GRAY}Project directory: %s${RESET}\n" "$PROJECT_DIR"
divider

# ── Step 1: Stop and remove containers ────────────────────────────────────────
step "Stop and remove containers"

COMPOSE_FILE="$PROJECT_DIR/docker-compose.yml"
if [[ -f "$COMPOSE_FILE" ]]; then
  if confirm "Stop all containers and remove networks?"; then
    docker compose -f "$COMPOSE_FILE" down --remove-orphans 2>/dev/null || true
    ok "Containers stopped and removed."
  else
    warn "Skipped — containers still running."
  fi
else
  warn "No docker-compose.yml found at $COMPOSE_FILE — trying to stop by container name."
  if confirm "Stop containers named mintlayer-*?"; then
    docker ps --filter "name=mintlayer-" -q | xargs -r docker stop
    docker ps -a --filter "name=mintlayer-" -q | xargs -r docker rm
    ok "Containers removed."
  fi
fi

# ── Step 2: Remove named volumes ──────────────────────────────────────────────
step "Remove Docker volumes (PostgreSQL data)"

if confirm "Remove named volumes? ${RED}This deletes all indexed blockchain data.${RESET}"; then
  if [[ -f "$COMPOSE_FILE" ]]; then
    docker compose -f "$COMPOSE_FILE" down -v 2>/dev/null || true
  fi
  # Remove any lingering mintlayer-prefixed volumes
  docker volume ls --filter "name=mintlayer" -q | xargs -r docker volume rm
  ok "Volumes removed."
else
  warn "Skipped — volumes kept."
fi

# ── Step 3: Remove Docker images ──────────────────────────────────────────────
step "Remove Docker images"

IMAGES=(
  mintlayer/node-daemon:latest
  mintlayer/wallet-rpc-daemon:latest
  mintlayer/wallet-cli:latest
  mintlayer/web-gui:latest
  mintlayer/api-blockchain-scanner-daemon:latest
  mintlayer/api-web-server:latest
  containrrr/watchtower
  caddy:alpine
  lscr.io/linuxserver/duckdns:latest
  postgres:16-alpine
)

if confirm "Remove all Mintlayer-related Docker images?"; then
  for img in "${IMAGES[@]}"; do
    if docker image inspect "$img" &>/dev/null; then
      docker rmi -f "$img" && ok "Removed $img" || warn "Could not remove $img (may be in use)"
    fi
  done
  # Also remove any locally built web-gui image
  docker images --filter "reference=web-gui" -q | xargs -r docker rmi -f
  ok "Images removed."
else
  warn "Skipped — images kept."
fi

# ── Step 4: Remove data directory ─────────────────────────────────────────────
step "Remove wallet and node data"

DATA_DIR="$PROJECT_DIR/mintlayer-data"
ENV_FILE="$PROJECT_DIR/.env"

if [[ -d "$DATA_DIR" ]]; then
  warn "This will permanently delete: wallet files, chain data, credentials."
  if confirm "Delete $DATA_DIR?"; then
    rm -rf "$DATA_DIR"
    ok "Deleted $DATA_DIR"
  else
    warn "Skipped — data directory kept."
  fi
else
  ok "No data directory found — already clean."
fi

if [[ -f "$ENV_FILE" ]]; then
  if confirm "Delete .env file?"; then
    rm -f "$ENV_FILE"
    ok "Deleted $ENV_FILE"
  else
    warn "Skipped — .env kept."
  fi
fi

# ── Step 5: Uninstall Docker engine ───────────────────────────────────────────
if $REMOVE_DOCKER; then
  step "Uninstall Docker engine"

  if ! command -v apt-get &>/dev/null; then
    err "--docker only supports apt-based systems (Debian/Ubuntu)."
    exit 1
  fi

  warn "This will remove Docker CE, the CLI, containerd, and all Docker data under /var/lib/docker."
  if confirm "Uninstall Docker engine?"; then
    apt-get purge -y \
      docker-ce docker-ce-cli containerd.io \
      docker-buildx-plugin docker-compose-plugin \
      docker-ce-rootless-extras 2>/dev/null || true
    apt-get autoremove -y
    rm -rf /var/lib/docker /var/lib/containerd /etc/docker
    ok "Docker engine removed."
  else
    warn "Skipped — Docker engine kept."
  fi
fi

# ── Done ──────────────────────────────────────────────────────────────────────
printf "\n${GREEN}◈${RESET} ${BOLD}Uninstall complete.${RESET}\n\n"
