#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Mintlayer Web GUI — remote installer
# Served at https://get.mintlayer.org/linux.sh  (also mac.sh)
# Usage: bash <(curl -sSL https://get.mintlayer.org/linux.sh)
#        bash <(curl -sSL https://get.mintlayer.org/mac.sh)
# ─────────────────────────────────────────────────────────────────────────────

# ── OS detection ──────────────────────────────────────────────────────────────
case "$(uname -s)" in
  Darwin) OS="macos" ;;
  *)      OS="linux" ;;
esac

# ── Colors & symbols ──────────────────────────────────────────────────────────
RESET=$'\033[0m'
BOLD=$'\033[1m'
DIM=$'\033[2m'
CYAN=$'\033[36m'
GREEN=$'\033[32m'
YELLOW=$'\033[33m'
RED=$'\033[31m'
GRAY=$'\033[90m'

step()    { printf "\n${CYAN}◆${RESET} ${BOLD}%s${RESET}\n" "$*"; }
ask()     { printf "${CYAN}◇${RESET} ${BOLD}%s${RESET}\n" "$*"; }
hint()    { printf "${GRAY}│  %s${RESET}\n" "$*"; }
ok()      { printf "${GREEN}◈${RESET} %s\n" "$*"; }
warn()    { printf "${YELLOW}▲${RESET}  %s\n" "$*"; }
err()     { printf "${RED}✗${RESET}  %s\n" "$*" >&2; }
divider() { printf "${GRAY}└─────────────────────────────────────────${RESET}\n"; }

prompt() {
  # prompt <var_name> <question> [default]
  local var="$1" question="$2" default="${3:-}"
  if [[ -n "$default" ]]; then
    printf "${CYAN}│${RESET}  ${question} ${GRAY}(${default})${RESET} "
  else
    printf "${CYAN}│${RESET}  ${question} "
  fi
  read -r input
  if [[ -z "$input" && -n "$default" ]]; then
    printf -v "$var" '%s' "$default"
  else
    printf -v "$var" '%s' "$input"
  fi
}

prompt_secret() {
  local var="$1" question="$2"
  printf "${CYAN}│${RESET}  ${question} "
  read -rs input
  printf '\n'
  printf -v "$var" '%s' "$input"
}

choose() {
  # choose <var_name> <question> <option1> <option2> [...]
  local var="$1"; shift
  local question="$1"; shift
  local options=("$@")
  printf "${CYAN}│${RESET}\n"
  printf "${CYAN}│${RESET}  %s\n" "$question"
  local i=1
  for opt in "${options[@]}"; do
    printf "${CYAN}│${RESET}    ${GRAY}%d)${RESET} %s\n" "$i" "$opt"
    (( i++ ))
  done
  while true; do
    printf "${CYAN}│${RESET}  ${GRAY}›${RESET} "
    read -r choice
    if [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= ${#options[@]} )); then
      printf -v "$var" '%s' "${options[$((choice-1))]}"
      break
    fi
    printf "${CYAN}│${RESET}  ${RED}Please enter a number between 1 and %d${RESET}\n" "${#options[@]}"
  done
}

confirm() {
  # confirm <var_name> <question> <default Y|N>
  local var="$1" question="$2" default="${3:-Y}"
  local hint_str
  if [[ "$default" == "Y" ]]; then hint_str="Y/n"; else hint_str="y/N"; fi
  printf "${CYAN}│${RESET}  %s ${GRAY}[%s]${RESET} " "$question" "$hint_str"
  read -r input
  input="${input:-$default}"
  if [[ "$input" =~ ^[Yy] ]]; then
    printf -v "$var" '%s' "yes"
  else
    printf -v "$var" '%s' "no"
  fi
}

rand_pass() {
  # Generate a 32-char alphanumeric password
  if command -v openssl &>/dev/null; then
    openssl rand -base64 48 | tr -dc 'a-zA-Z0-9' | head -c 32
  else
    cat /dev/urandom | tr -dc 'a-zA-Z0-9' | head -c 32
  fi
}

# ── Bootstrap: create install dir and write docker-compose.yml ────────────────
bootstrap_remote() {
  printf "\n"
  printf "${CYAN}◆${RESET} ${BOLD}Install location${RESET}\n"
  printf "${GRAY}│  Where should Mintlayer Web GUI be installed?${RESET}\n"
  printf "${CYAN}│${RESET}  Directory: ${GRAY}(${HOME}/mintlayer)${RESET} "
  read -r input
  INSTALL_DIR="${input:-${HOME}/mintlayer}"

  mkdir -p "$INSTALL_DIR"
  cd "$INSTALL_DIR"

  if [[ -f docker-compose.yml ]]; then
    ok "docker-compose.yml already exists — skipping"
  else
    cat > docker-compose.yml << 'COMPOSE_EOF'
x-common: &common
  volumes:
    - "./mintlayer-data:/home/mintlayer"
  restart: unless-stopped

x-common-env: &common-env
  ML_USER_ID: "${ML_USER_ID:-1000}"
  ML_GROUP_ID: "${ML_GROUP_ID:-1000}"

# Both mainnet and testnet env vars are set to the same credential values.
# Only the vars matching the active NETWORK are picked up by each daemon.
x-node-rpc-env: &node-rpc-env
  ML_MAINNET_NODE_RPC_USERNAME: "${NODE_RPC_USERNAME}"
  ML_MAINNET_NODE_RPC_PASSWORD: "${NODE_RPC_PASSWORD}"
  ML_TESTNET_NODE_RPC_USERNAME: "${NODE_RPC_USERNAME}"
  ML_TESTNET_NODE_RPC_PASSWORD: "${NODE_RPC_PASSWORD}"

services:
  # ─────────────────────────────────────────
  # Core: Mintlayer full node
  # ─────────────────────────────────────────
  node-daemon:
    <<: *common
    image: "mintlayer/node-daemon:latest"
    command: "node-daemon ${NETWORK:-mainnet}"
    environment:
      <<: [*common-env, *node-rpc-env]
      RUST_LOG: "${RUST_LOG:-info}"
      ML_MAINNET_NODE_RPC_BIND_ADDRESS: "0.0.0.0:3030"
      ML_TESTNET_NODE_RPC_BIND_ADDRESS: "0.0.0.0:3030"
    # Uncomment to expose the node RPC to the host
    # ports:
    #   - "3030:3030"

  # ─────────────────────────────────────────
  # Core: Wallet RPC daemon (headless wallet)
  #
  # WALLET_RPC_CMD is written by init.sh and contains the full resolved
  # command, e.g. "wallet-rpc-daemon mainnet --wallet-file /home/mintlayer/wallet"
  # Run ./init.sh (or edit .env manually) to change it.
  # ─────────────────────────────────────────
  wallet-rpc-daemon:
    <<: *common
    image: "mintlayer/wallet-rpc-daemon:latest"
    command: "${WALLET_RPC_CMD:-wallet-rpc-daemon mainnet}"
    depends_on:
      - node-daemon
    environment:
      <<: *common-env
      RUST_LOG: "${RUST_LOG:-info}"
      # Mainnet
      ML_MAINNET_WALLET_RPC_DAEMON_NODE_RPC_ADDRESS: "node-daemon:3030"
      ML_MAINNET_WALLET_RPC_DAEMON_NODE_RPC_USERNAME: "${NODE_RPC_USERNAME}"
      ML_MAINNET_WALLET_RPC_DAEMON_NODE_RPC_PASSWORD: "${NODE_RPC_PASSWORD}"
      ML_MAINNET_WALLET_RPC_DAEMON_RPC_BIND_ADDRESS: "0.0.0.0:3034"
      ML_MAINNET_WALLET_RPC_DAEMON_RPC_USERNAME: "${WALLET_RPC_USERNAME}"
      ML_MAINNET_WALLET_RPC_DAEMON_RPC_PASSWORD: "${WALLET_RPC_PASSWORD}"
      # Testnet
      ML_TESTNET_WALLET_RPC_DAEMON_NODE_RPC_ADDRESS: "node-daemon:3030"
      ML_TESTNET_WALLET_RPC_DAEMON_NODE_RPC_USERNAME: "${NODE_RPC_USERNAME}"
      ML_TESTNET_WALLET_RPC_DAEMON_NODE_RPC_PASSWORD: "${NODE_RPC_PASSWORD}"
      ML_TESTNET_WALLET_RPC_DAEMON_RPC_BIND_ADDRESS: "0.0.0.0:3034"
      ML_TESTNET_WALLET_RPC_DAEMON_RPC_USERNAME: "${WALLET_RPC_USERNAME}"
      ML_TESTNET_WALLET_RPC_DAEMON_RPC_PASSWORD: "${WALLET_RPC_PASSWORD}"
    restart: on-failure
    # ports:
    #   - "3034:3034"

  # ─────────────────────────────────────────
  # Web GUI (Astro SSR app)
  # ─────────────────────────────────────────
  web-gui:
    image: "mintlayer/web-gui:latest"
    depends_on:
      - wallet-rpc-daemon
    volumes:
      # Read-only access to wallet data for file backup download
      - "./mintlayer-data:/app/mintlayer-data:ro"
      # Shared with wallet-rpc-daemon's /home/mintlayer/ so uploaded wallet files
      # are accessible to the daemon at /home/mintlayer/uploads/<filename>
      - "./mintlayer-data/uploads:/app/uploads"
      # Server-side preferences (SQLite) — persists across browsers and restarts
      - "./mintlayer-data/prefs:/app/prefs"
    ports:
      - "127.0.0.1:4321:4321"
    environment:
      WALLET_RPC_URL: "http://wallet-rpc-daemon:3034"
      WALLET_RPC_USERNAME: "${WALLET_RPC_USERNAME}"
      WALLET_RPC_PASSWORD: "${WALLET_RPC_PASSWORD}"
      NODE_RPC_URL: "http://node-daemon:3030"
      NODE_RPC_USERNAME: "${NODE_RPC_USERNAME}"
      NODE_RPC_PASSWORD: "${NODE_RPC_PASSWORD}"
      NETWORK: "${NETWORK:-mainnet}"
      INDEXER_URL: "http://api-web-server:3000"
      PINATA_JWT: "${PINATA_JWT:-}"
      IPFS_PROVIDER: "${IPFS_PROVIDER:-}"
      FILEBASE_TOKEN: "${FILEBASE_TOKEN:-}"
      UI_PASSWORD_HASH: "${UI_PASSWORD_HASH}"
      UI_TOTP_SECRET: "${UI_TOTP_SECRET}"
      SESSION_SECRET: "${SESSION_SECRET}"
      WALLET_RPC_CMD: "${WALLET_RPC_CMD:-}"
      INDEXER_ENABLED: "${INDEXER_ENABLED:-false}"
      HOST: "0.0.0.0"
      PORT: "4321"
    restart: unless-stopped

  # ─────────────────────────────────────────
  # Optional: wallet-cli  (profile: wallet_cli)
  # Usage: docker compose run --rm wallet-cli
  # ─────────────────────────────────────────
  wallet-cli:
    <<: *common
    image: "mintlayer/wallet-cli:latest"
    command: "wallet-cli"
    depends_on:
      - wallet-rpc-daemon
    environment:
      <<: *common-env
      ML_WALLET_REMOTE_RPC_WALLET_ADDRESS: "wallet-rpc-daemon:3034"
      ML_WALLET_REMOTE_RPC_WALLET_USERNAME: "${WALLET_RPC_USERNAME}"
      ML_WALLET_REMOTE_RPC_WALLET_PASSWORD: "${WALLET_RPC_PASSWORD}"
    profiles:
      - wallet_cli

  # ─────────────────────────────────────────
  # Optional: Indexer stack  (profile: indexer)
  # Start with: docker compose --profile indexer up -d
  # ─────────────────────────────────────────
  postgres:
    image: "postgres:16-alpine"
    volumes:
      - "postgres-data:/var/lib/postgresql/data"
    environment:
      POSTGRES_USER: "${POSTGRES_USER:-mintlayer}"
      POSTGRES_PASSWORD: "${POSTGRES_PASSWORD:-}"
      POSTGRES_DB: "${POSTGRES_DB:-mintlayer}"
    profiles:
      - indexer
    restart: unless-stopped

  api-blockchain-scanner-daemon:
    <<: *common
    image: "mintlayer/api-blockchain-scanner-daemon:latest"
    depends_on:
      - node-daemon
      - postgres
    environment:
      <<: *common-env
      RUST_LOG: "${RUST_LOG:-info}"
      ML_API_SCANNER_DAEMON_NETWORK: "${NETWORK:-mainnet}"
      ML_API_SCANNER_DAEMON_NODE_RPC_ADDRESS: "node-daemon:3030"
      ML_API_SCANNER_DAEMON_NODE_RPC_USERNAME: "${NODE_RPC_USERNAME}"
      ML_API_SCANNER_DAEMON_NODE_RPC_PASSWORD: "${NODE_RPC_PASSWORD}"
      ML_API_SCANNER_DAEMON_POSTGRES_HOST: "postgres"
      ML_API_SCANNER_DAEMON_POSTGRES_USER: "${POSTGRES_USER:-mintlayer}"
      ML_API_SCANNER_DAEMON_POSTGRES_PASSWORD: "${POSTGRES_PASSWORD:-}"
      ML_API_SCANNER_DAEMON_POSTGRES_DATABASE: "${POSTGRES_DB:-mintlayer}"
    profiles:
      - indexer
    restart: unless-stopped

  api-web-server:
    image: "mintlayer/api-web-server:latest"
    depends_on:
      - postgres
      - node-daemon
    environment:
      ML_API_WEB_SRV_NETWORK: "${NETWORK:-mainnet}"
      ML_API_WEB_SRV_BIND_ADDRESS: "0.0.0.0:3000"
      ML_API_WEB_SRV_NODE_RPC_ADDRESS: "node-daemon:3030"
      ML_API_WEB_SRV_NODE_RPC_USERNAME: "${NODE_RPC_USERNAME}"
      ML_API_WEB_SRV_NODE_RPC_PASSWORD: "${NODE_RPC_PASSWORD}"
      ML_API_WEB_SRV_POSTGRES_HOST: "postgres"
      ML_API_WEB_SRV_POSTGRES_USER: "${POSTGRES_USER:-mintlayer}"
      ML_API_WEB_SRV_POSTGRES_PASSWORD: "${POSTGRES_PASSWORD:-}"
      ML_API_WEB_SRV_POSTGRES_DATABASE: "${POSTGRES_DB:-mintlayer}"
    profiles:
      - indexer
    restart: unless-stopped

  # ─────────────────────────────────────────
  # Optional: HTTPS via Caddy  (profile: https)
  # Automatically provisions a TLS certificate via Let's Encrypt.
  # Activate with: docker compose --profile https up -d
  # ─────────────────────────────────────────
  caddy:
    image: caddy:alpine
    command: caddy reverse-proxy --from https://${DOMAIN} --to web-gui:4321
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - "caddy-data:/data"
      - "caddy-config:/config"
    depends_on:
      - web-gui
    profiles:
      - https
    restart: unless-stopped

  # ─────────────────────────────────────────
  # Optional: DuckDNS dynamic DNS updater  (profile: duckdns)
  # Keeps your duckdns.org subdomain pointing at this server's IP.
  # Activate alongside https: docker compose --profile https --profile duckdns up -d
  # ─────────────────────────────────────────
  duckdns:
    image: lscr.io/linuxserver/duckdns:latest
    environment:
      SUBDOMAINS: "${DUCKDNS_SUBDOMAIN:-}"
      TOKEN: "${DUCKDNS_TOKEN:-}"
      TZ: "UTC"
      LOG_FILE: "false"
    profiles:
      - duckdns
    restart: unless-stopped

volumes:
  postgres-data:
  caddy-data:
  caddy-config:
COMPOSE_EOF
    ok "docker-compose.yml written to ${INSTALL_DIR}"
  fi

  printf "${GRAY}└─────────────────────────────────────────${RESET}\n"
}

# ── Docker install instructions ───────────────────────────────────────────────
docker_install_hint() {
  printf "\n"
  if [[ "$OS" == "macos" ]]; then
    printf "${BOLD}  Install Docker Desktop for Mac:${RESET}\n"
    printf "  1. Download from https://docs.docker.com/desktop/install/mac-install/\n"
    printf "  2. Open the .dmg and drag Docker to Applications\n"
    printf "  3. Launch Docker Desktop and wait for the whale icon to stop animating\n"
    printf "  4. Re-run this script\n"
  else
    printf "${BOLD}  Install Docker Engine on Linux:${RESET}\n"
    printf "  Ubuntu/Debian:\n"
    printf "    curl -fsSL https://get.docker.com | sh\n"
    printf "    sudo usermod -aG docker \$USER   # then log out and back in\n"
    printf "\n"
    printf "  Or follow the official guide for your distro:\n"
    printf "  https://docs.docker.com/engine/install/\n"
    printf "\n"
    printf "  After installing, re-run this script.\n"
  fi
  printf "\n"
}

# ── Prerequisite checks ───────────────────────────────────────────────────────
check_prereqs() {
  if ! command -v docker &>/dev/null; then
    if [[ "$OS" == "macos" ]]; then
      err "Docker is not installed or not in PATH."
      docker_install_hint
      exit 1
    else
      # Linux — offer automatic installation
      warn "Docker is not installed."
      printf "${CYAN}│${RESET}\n"
      _can_sudo=false
      if [ "$(id -u)" -eq 0 ]; then
        _can_sudo=true
      elif command -v sudo &>/dev/null && sudo -n true 2>/dev/null; then
        _can_sudo=true
      elif command -v sudo &>/dev/null; then
        # sudo exists but requires a password — try it
        printf "${CYAN}│${RESET}  ${BOLD}sudo is required to install Docker.${RESET}\n"
        if sudo true 2>/dev/null; then
          _can_sudo=true
        fi
      fi

      if [[ "$_can_sudo" == "true" ]]; then
        _install_docker="no"
        confirm _install_docker "Install Docker automatically using get.docker.com?" "Y"
        if [[ "$_install_docker" == "yes" ]]; then
          step "Installing Docker"
          hint "Running the official Docker install script from get.docker.com…"
          printf "${CYAN}│${RESET}\n"
          if [ "$(id -u)" -eq 0 ]; then
            curl -fsSL https://get.docker.com | sh
          else
            curl -fsSL https://get.docker.com | sudo sh
          fi
          if ! command -v docker &>/dev/null; then
            err "Docker installation failed. Please install manually."
            docker_install_hint
            exit 1
          fi
          ok "Docker installed."

          # Add current user to docker group so docker works without sudo
          if [ "$(id -u)" -ne 0 ] && command -v usermod &>/dev/null; then
            sudo usermod -aG docker "$USER" 2>/dev/null || true
            hint "Added ${USER} to the docker group."
          fi

          # Enable and start the docker service
          if command -v systemctl &>/dev/null; then
            if [ "$(id -u)" -eq 0 ]; then
              systemctl enable --now docker 2>/dev/null || true
            else
              sudo systemctl enable --now docker 2>/dev/null || true
            fi
          fi

          # newgrp trick: re-exec this script under the docker group so we don't
          # need a full logout/login just to use docker in the current shell.
          if ! docker info &>/dev/null 2>&1; then
            hint "Activating docker group membership without logout…"
            exec sg docker "$0" "$@"
          fi

          divider
        else
          err "Docker is required to continue."
          docker_install_hint
          exit 1
        fi
      else
        err "Docker is not installed and sudo is not available to install it automatically."
        docker_install_hint
        exit 1
      fi
    fi
  fi

  if ! docker info &>/dev/null 2>&1; then
    err "Docker is installed but the daemon is not running."
    if [[ "$OS" == "macos" ]]; then
      printf "  ${YELLOW}▲${RESET}  Start Docker Desktop and wait for it to finish loading, then re-run this script.\n\n"
    else
      printf "  ${YELLOW}▲${RESET}  Run: ${GRAY}sudo systemctl start docker${RESET}\n\n"
    fi
    exit 1
  fi

  if ! docker compose version &>/dev/null 2>&1 && ! command -v docker-compose &>/dev/null; then
    err "Docker Compose is not available."
    if [[ "$OS" == "macos" ]]; then
      printf "  Docker Compose is bundled with Docker Desktop for Mac.\n"
      printf "  Download Docker Desktop from https://docs.docker.com/desktop/install/mac-install/\n\n"
    else
      printf "  Install with: ${GRAY}sudo apt install docker-compose-plugin${RESET}\n"
      printf "  Or see: https://docs.docker.com/compose/install/\n\n"
    fi
    exit 1
  fi

  command -v python3 &>/dev/null || {
    err "Python 3 is not installed (required for password hashing)."
    if [[ "$OS" == "macos" ]]; then
      printf "  Install with: ${GRAY}brew install python3${RESET}\n"
      printf "  Or download from https://www.python.org/downloads/macos/\n\n"
    else
      printf "  Install with: ${GRAY}sudo apt install python3${RESET}\n\n"
    fi
    exit 1
  }
}

# ── Determine compose command ─────────────────────────────────────────────────
compose_cmd() {
  if docker compose version &>/dev/null 2>&1; then
    echo "docker compose"
  else
    echo "docker-compose"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# Bootstrap + prereqs
# ─────────────────────────────────────────────────────────────────────────────
bootstrap_remote
check_prereqs

# ─────────────────────────────────────────────────────────────────────────────
# Banner
# ─────────────────────────────────────────────────────────────────────────────
clear
printf "\n"
printf "${CYAN}${BOLD}"
printf "  ███╗   ███╗██╗███╗   ██╗████████╗██╗      █████╗ ██╗   ██╗███████╗██████╗ \n"
printf "  ████╗ ████║██║████╗  ██║╚══██╔══╝██║     ██╔══██╗╚██╗ ██╔╝██╔════╝██╔══██╗\n"
printf "  ██╔████╔██║██║██╔██╗ ██║   ██║   ██║     ███████║ ╚████╔╝ █████╗  ██████╔╝\n"
printf "  ██║╚██╔╝██║██║██║╚██╗██║   ██║   ██║     ██╔══██║  ╚██╔╝  ██╔══╝  ██╔══██╗\n"
printf "  ██║ ╚═╝ ██║██║██║ ╚████║   ██║   ███████╗██║  ██║   ██║   ███████╗██║  ██║\n"
printf "  ╚═╝     ╚═╝╚═╝╚═╝  ╚═══╝   ╚═╝   ╚══════╝╚═╝  ╚═╝   ╚═╝   ╚══════╝╚═╝  ╚═╝\n"
printf "${RESET}"
printf "\n"
printf "  ${BOLD}Web GUI Setup${RESET}  ${GRAY}— node + wallet-rpc-daemon + web interface${RESET}\n"
printf "\n"
printf "${GRAY}  This script writes your .env and starts the Docker stack.${RESET}\n"
printf "\n"

# ─────────────────────────────────────────────────────────────────────────────
# Root warning
# ─────────────────────────────────────────────────────────────────────────────
if [ "$(id -u)" -eq 0 ]; then
  printf "${YELLOW}┌─────────────────────────────────────────────────────────────────────┐${RESET}\n"
  printf "${YELLOW}│  ⚠  Running as root                                                 │${RESET}\n"
  printf "${YELLOW}└─────────────────────────────────────────────────────────────────────┘${RESET}\n"
  printf "\n"
  printf "  Running this setup as ${BOLD}root${RESET} is not recommended for a production wallet\n"
  printf "  server. Any vulnerability in the app would give an attacker full host access.\n"
  printf "\n"
  printf "  ${BOLD}Recommended:${RESET} create a dedicated user and re-run this script as that user:\n"
  printf "\n"
  printf "    ${GRAY}adduser mintlayer${RESET}\n"
  printf "    ${GRAY}usermod -aG docker mintlayer${RESET}\n"
  printf "    ${GRAY}su - mintlayer${RESET}   ${GRAY}# then re-run this script${RESET}\n"
  printf "\n"
  printf "  Your existing SSH keys stay in ${GRAY}/root/.ssh/${RESET} — log back in as root\n"
  printf "  to administer the server; use the mintlayer user only for this stack.\n"
  printf "\n"
  _continue_as_root="no"
  confirm _continue_as_root "Continue as root anyway?" "N"
  if [[ "$_continue_as_root" != "yes" ]]; then
    printf "\n"
    ok "Exiting. Re-run as a non-root user when ready."
    exit 0
  fi
  printf "\n"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Step 1 — Network
# ─────────────────────────────────────────────────────────────────────────────
step "Network"
hint "mainnet uses real ML tokens; testnet is for experimentation"
hint ""

NETWORK_CHOICE=""
choose NETWORK_CHOICE "Which network?" \
  "mainnet  — real funds" \
  "testnet  — for testing, no real value"

case "$NETWORK_CHOICE" in
  "mainnet  — real funds") NETWORK="mainnet" ;;
  *)                       NETWORK="testnet" ;;
esac

divider

# ─────────────────────────────────────────────────────────────────────────────
# Step 2 — Passwords
# ─────────────────────────────────────────────────────────────────────────────
step "Passwords"
hint "Two internal RPC services need authentication."
hint ""

USE_RANDOM_PASSWORDS="yes"
confirm USE_RANDOM_PASSWORDS "Generate secure random passwords automatically?" "Y"

if [[ "$USE_RANDOM_PASSWORDS" == "yes" ]]; then
  NODE_RPC_PASSWORD=$(rand_pass)
  WALLET_RPC_PASSWORD=$(rand_pass)
  ok "Generated random passwords (saved to .env)"
else
  ask "Node RPC password"
  hint "Used by node-daemon — not exposed outside Docker"
  prompt_secret NODE_RPC_PASSWORD "Password:"
  while [[ ${#NODE_RPC_PASSWORD} -lt 8 ]]; do
    printf "${CYAN}│${RESET}  ${RED}Password must be at least 8 characters${RESET}\n"
    prompt_secret NODE_RPC_PASSWORD "Password:"
  done

  ask "Wallet RPC password"
  hint "Used by wallet-rpc-daemon — not exposed outside Docker"
  prompt_secret WALLET_RPC_PASSWORD "Password:"
  while [[ ${#WALLET_RPC_PASSWORD} -lt 8 ]]; do
    printf "${CYAN}│${RESET}  ${RED}Password must be at least 8 characters${RESET}\n"
    prompt_secret WALLET_RPC_PASSWORD "Password:"
  done
fi

NODE_RPC_USERNAME="node_user"
WALLET_RPC_USERNAME="wallet_user"

divider

# ─────────────────────────────────────────────────────────────────────────────
# Step 3 — Web UI access (password + TOTP 2FA)
# ─────────────────────────────────────────────────────────────────────────────
step "Web UI access"
hint "Protect the wallet interface with a password and authenticator app (TOTP 2FA)."
hint ""

ask "Web UI password"
hint "Used to sign in to the wallet web interface."
hint "Choose a strong password — this guards access to your wallet."
UI_PASSWORD=""
UI_PASSWORD_CONFIRM=""
prompt_secret UI_PASSWORD "Password:"
while [[ ${#UI_PASSWORD} -lt 8 ]]; do
  printf "${CYAN}│${RESET}  ${RED}Password must be at least 8 characters${RESET}\n"
  prompt_secret UI_PASSWORD "Password:"
done
prompt_secret UI_PASSWORD_CONFIRM "Confirm password:"
while [[ "$UI_PASSWORD" != "$UI_PASSWORD_CONFIRM" ]]; do
  printf "${CYAN}│${RESET}  ${RED}Passwords do not match, try again${RESET}\n"
  prompt_secret UI_PASSWORD "Password:"
  while [[ ${#UI_PASSWORD} -lt 8 ]]; do
    printf "${CYAN}│${RESET}  ${RED}Password must be at least 8 characters${RESET}\n"
    prompt_secret UI_PASSWORD "Password:"
  done
  prompt_secret UI_PASSWORD_CONFIRM "Confirm password:"
done

printf "${CYAN}│${RESET}\n"
hint "Hashing password (this may take a moment)..."
UI_PASSWORD_HASH=$(python3 -c "
import hashlib, os, sys
password = sys.argv[1]
salt = os.urandom(32).hex()
key = hashlib.pbkdf2_hmac('sha512', password.encode(), salt.encode(), 100000)
print('pbkdf2:sha512:100000:' + salt + ':' + key.hex(), end='')
" "$UI_PASSWORD")
ok "Password hashed"

# Generate TOTP secret (20 random bytes → base32)
UI_TOTP_SECRET=$(python3 -c "
import os, base64
print(base64.b32encode(os.urandom(20)).decode(), end='')
")

# Generate session signing secret
SESSION_SECRET=$(openssl rand -hex 32)

# Construct the otpauth URI
TOTP_URI="otpauth://totp/Mintlayer%20GUI-X?secret=${UI_TOTP_SECRET}&issuer=Mintlayer"

printf "${CYAN}│${RESET}\n"
ok "TOTP secret generated"
printf "${CYAN}│${RESET}\n"
printf "${CYAN}│${RESET}  ${BOLD}Scan this with Google Authenticator, Authy, or any TOTP app:${RESET}\n"
printf "${CYAN}│${RESET}\n"

# Show QR code if qrencode is available, otherwise offer to install it
if ! command -v qrencode &>/dev/null; then
  printf "${CYAN}│${RESET}  ${DIM}qrencode is not installed — needed to show a scannable QR code.${RESET}\n"
  INSTALL_QRENCODE="no"
  if command -v sudo &>/dev/null && sudo -n true 2>/dev/null; then
    confirm INSTALL_QRENCODE "Install qrencode now (sudo available)?" "Y"
  elif command -v sudo &>/dev/null; then
    confirm INSTALL_QRENCODE "Install qrencode now? (will prompt for sudo password)" "Y"
  fi
  if [[ "$INSTALL_QRENCODE" == "yes" ]]; then
    if command -v apt-get &>/dev/null; then
      sudo apt-get install -y -qq qrencode 2>/dev/null && ok "qrencode installed"
    elif command -v brew &>/dev/null; then
      brew install qrencode -q 2>/dev/null && ok "qrencode installed"
    elif command -v dnf &>/dev/null; then
      sudo dnf install -y -q qrencode 2>/dev/null && ok "qrencode installed"
    elif command -v pacman &>/dev/null; then
      sudo pacman -S --noconfirm qrencode 2>/dev/null && ok "qrencode installed"
    else
      warn "Could not detect package manager — install qrencode manually for a QR code."
    fi
  fi
fi

if command -v qrencode &>/dev/null; then
  echo "$TOTP_URI" | qrencode -t ANSIUTF8 | sed "s/^/${CYAN}│${RESET}  /"
else
  printf "${CYAN}│${RESET}  ${GRAY}%s${RESET}\n" "$TOTP_URI"
fi

printf "${CYAN}│${RESET}\n"
hint "Or enter the secret manually: ${BOLD}${UI_TOTP_SECRET}${RESET}"
printf "${CYAN}│${RESET}\n"
warn "Scan this QR code NOW before continuing — it will not be shown again."
printf "${CYAN}│${RESET}\n"
SCANNED="no"
confirm SCANNED "I have scanned the QR code / saved the TOTP secret" "N"
while [[ "$SCANNED" != "yes" ]]; do
  printf "${CYAN}│${RESET}  ${RED}Please scan the QR code or save the secret before continuing.${RESET}\n"
  printf "${CYAN}│${RESET}\n"
  if command -v qrencode &>/dev/null; then
    echo "$TOTP_URI" | qrencode -t ANSIUTF8 | sed "s/^/${CYAN}│${RESET}  /"
  else
    printf "${CYAN}│${RESET}  ${GRAY}%s${RESET}\n" "$TOTP_URI"
  fi
  printf "${CYAN}│${RESET}\n"
  confirm SCANNED "I have scanned the QR code / saved the TOTP secret" "N"
done
ok "2FA configured"

divider

# ─────────────────────────────────────────────────────────────────────────────
# Step 4 — HTTPS / Public access
# ─────────────────────────────────────────────────────────────────────────────
step "HTTPS / Public access"
hint "Caddy can automatically provision a free TLS certificate (Let's Encrypt)"
hint "so the GUI is served over HTTPS — recommended for internet-facing servers."
hint ""

HTTPS_SETUP="no"
confirm HTTPS_SETUP "Set up HTTPS with automatic TLS certificate?" "N"

DOMAIN=""
DUCKDNS_SUBDOMAIN=""
DUCKDNS_TOKEN=""

if [[ "$HTTPS_SETUP" == "yes" ]]; then
  DOMAIN_TYPE=""
  choose DOMAIN_TYPE "How will you reach this server?" \
    "I have a domain name already pointing at this server's IP" \
    "Set up a free DuckDNS subdomain (e.g. mywallet.duckdns.org)"

  case "$DOMAIN_TYPE" in
    *"domain name"*)
      ask "Domain name"
      hint "e.g. wallet.example.com — DNS must already resolve to this server"
      prompt DOMAIN "Domain:"
      while [[ -z "$DOMAIN" ]]; do
        printf "${CYAN}│${RESET}  ${RED}Domain cannot be empty${RESET}\n"
        prompt DOMAIN "Domain:"
      done
      ok "Domain: ${DOMAIN}"
      ;;
    *"DuckDNS"*)
      ask "DuckDNS setup"
      hint "1. Go to https://www.duckdns.org and sign in (free, no expiry)"
      hint "2. Create a subdomain, e.g. 'mywallet' → mywallet.duckdns.org"
      hint "3. Copy the token shown at the top of the page"
      printf "${CYAN}│${RESET}\n"
      prompt DUCKDNS_SUBDOMAIN "Subdomain (without .duckdns.org):"
      while [[ -z "$DUCKDNS_SUBDOMAIN" ]]; do
        printf "${CYAN}│${RESET}  ${RED}Subdomain cannot be empty${RESET}\n"
        prompt DUCKDNS_SUBDOMAIN "Subdomain:"
      done
      prompt_secret DUCKDNS_TOKEN "DuckDNS token:"
      while [[ -z "$DUCKDNS_TOKEN" ]]; do
        printf "${CYAN}│${RESET}  ${RED}Token cannot be empty${RESET}\n"
        prompt_secret DUCKDNS_TOKEN "DuckDNS token:"
      done
      DOMAIN="${DUCKDNS_SUBDOMAIN}.duckdns.org"
      ok "DuckDNS configured — ${DOMAIN}"
      ;;
  esac

  printf "${CYAN}│${RESET}\n"
  warn "Ensure ports 80 and 443 are open in your firewall / security group."
fi

divider

# ─────────────────────────────────────────────────────────────────────────────
# Step 5 — IPFS Storage Provider (optional)
# ─────────────────────────────────────────────────────────────────────────────
step "IPFS Storage Provider (optional)"
hint "Enables automatic upload of token/NFT images and metadata to IPFS."
hint "Without this, uploads are disabled — URLs can still be entered manually."
hint ""
hint "Provider comparison:"
hint "  Filebase — 5 GB free, always public"
hint "             Sign up: https://filebase.com"
hint "  Pinata   — free tier keeps files PRIVATE (requires paid plan for public)"
hint "             Sign up: https://app.pinata.cloud"
hint ""

IPFS_PROVIDER=""
FILEBASE_TOKEN=""
PINATA_JWT=""

IPFS_CHOICE=""
choose IPFS_CHOICE "Choose IPFS provider:" \
  "Filebase (recommended — 5 GB free, always public)" \
  "Pinata (paid account required to make files public)" \
  "None — disable IPFS uploads"

case "$IPFS_CHOICE" in
  *"Filebase"*)
    IPFS_PROVIDER="filebase"
    ask "Filebase API key"
    hint "Find it at https://console.filebase.com/keys — scroll to the bottom"
    hint "for the bucket-specific IPFS API keys (not the S3 access keys at the top)."
    prompt_secret FILEBASE_TOKEN "API key:"
    while [[ -z "$FILEBASE_TOKEN" ]]; do
      printf "${CYAN}│${RESET}  ${RED}API key cannot be empty${RESET}\n"
      prompt_secret FILEBASE_TOKEN "API key:"
    done
    ok "Filebase API key saved"
    ;;
  *"Pinata"*)
    IPFS_PROVIDER="pinata"
    ask "Pinata JWT"
    hint "Paste your JWT — stored in .env, never sent to the browser."
    prompt_secret PINATA_JWT "JWT:"
    while [[ -z "$PINATA_JWT" ]]; do
      printf "${CYAN}│${RESET}  ${RED}JWT cannot be empty${RESET}\n"
      prompt_secret PINATA_JWT "JWT:"
    done
    ok "Pinata JWT saved"
    ;;
  *)
    hint "Skipping — add IPFS_PROVIDER to .env later to enable uploads."
    ;;
esac

divider

# ─────────────────────────────────────────────────────────────────────────────
# Step 6 — Indexer (optional)
# ─────────────────────────────────────────────────────────────────────────────
step "Indexer stack (optional)"
hint "Adds: PostgreSQL + api-blockchain-scanner-daemon + api-web-server"
hint "Provides a REST API for querying blockchain data (blocks, transactions, addresses)."
hint "Requires more resources and disk space."
hint ""
warn "Without the indexer, Token Management and Trading are disabled in the web UI."
hint "Staking, sending, receiving, and all basic wallet features work fine without it."
hint ""

ENABLE_INDEXER="no"
confirm ENABLE_INDEXER "Enable the indexer stack?" "N"

POSTGRES_PASSWORD=""
if [[ "$ENABLE_INDEXER" == "yes" ]]; then
  if [[ "$USE_RANDOM_PASSWORDS" == "yes" ]]; then
    POSTGRES_PASSWORD=$(rand_pass)
    ok "Generated random PostgreSQL password (saved to .env)"
  else
    ask "PostgreSQL password"
    prompt_secret POSTGRES_PASSWORD "Password:"
    while [[ ${#POSTGRES_PASSWORD} -lt 8 ]]; do
      printf "${CYAN}│${RESET}  ${RED}Password must be at least 8 characters${RESET}\n"
      prompt_secret POSTGRES_PASSWORD "Password:"
    done
  fi
fi

divider

# ─────────────────────────────────────────────────────────────────────────────
# Step 7 — Firewall (optional, Linux only)
# ─────────────────────────────────────────────────────────────────────────────
SETUP_FIREWALL="no"
if [[ "$OS" == "linux" ]]; then
  step "Firewall"
  hint "A firewall restricts inbound traffic to SSH, HTTP, and HTTPS only."
  hint "All other ports (including direct access to node/wallet RPCs) will be blocked."
  hint ""
  if ! command -v sudo &>/dev/null && ! [ "$(id -u)" -eq 0 ]; then
    hint "Skipping — sudo is not available and not running as root."
  elif ! command -v ufw &>/dev/null && ! command -v firewall-cmd &>/dev/null; then
    hint "Skipping — neither ufw nor firewalld found on this system."
  else
    printf "${CYAN}│${RESET}\n"
    printf "${RED}│${RESET}  ${BOLD}⚠  WARNING — READ CAREFULLY${RESET}\n"
    printf "${RED}│${RESET}\n"
    printf "${RED}│${RESET}  Enabling a firewall will block ALL inbound ports except:\n"
    printf "${RED}│${RESET}    • SSH  (port 22)\n"
    printf "${RED}│${RESET}    • HTTP (port 80)\n"
    printf "${RED}│${RESET}    • HTTPS (port 443)\n"
    printf "${RED}│${RESET}\n"
    printf "${RED}│${RESET}  ${BOLD}If your SSH session uses a non-standard port you will be locked out.${RESET}\n"
    printf "${RED}│${RESET}  ${BOLD}If you are unsure, answer N and configure the firewall manually.${RESET}\n"
    printf "${CYAN}│${RESET}\n"

    confirm SETUP_FIREWALL "Set up firewall now? (this modifies live network rules)" "N"

    if [[ "$SETUP_FIREWALL" == "yes" ]]; then
      printf "${CYAN}│${RESET}\n"
      printf "${CYAN}│${RESET}  ${BOLD}Final confirmation required.${RESET}\n"
      printf "${CYAN}│${RESET}  Type ${BOLD}YES${RESET} (uppercase) to proceed: "
      read -r FIREWALL_CONFIRM
      if [[ "$FIREWALL_CONFIRM" != "YES" ]]; then
        SETUP_FIREWALL="no"
        warn "Firewall setup cancelled."
      fi
    fi
  fi
fi

divider

# ─────────────────────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────────────────────
printf "\n"
step "Summary"
printf "${CYAN}│${RESET}\n"
printf "${CYAN}│${RESET}  %-22s %s\n" "Network:"           "${BOLD}${NETWORK}${RESET}"
printf "${CYAN}│${RESET}  %-22s %s\n" "Passwords:"  "${BOLD}$([ "$USE_RANDOM_PASSWORDS" == "yes" ] && echo "randomly generated" || echo "custom")${RESET}"
printf "${CYAN}│${RESET}  %-22s %s\n" "Web UI auth:"  "${BOLD}password + TOTP 2FA${RESET}"
printf "${CYAN}│${RESET}  %-22s %s\n" "Web GUI:"    "${BOLD}$([ "$HTTPS_SETUP" == "yes" ] && echo "https://${DOMAIN}" || echo "http://<your-server-ip>:4321")${RESET}"
printf "${CYAN}│${RESET}  %-22s %s\n" "IPFS storage:" "${BOLD}$([ -n "$IPFS_PROVIDER" ] && echo "$IPFS_PROVIDER" || echo "disabled — token/NFT uploads disabled")${RESET}"
printf "${CYAN}│${RESET}  %-22s %s\n" "Indexer:"    "${BOLD}$([ "$ENABLE_INDEXER" == "yes" ] && echo "enabled — Token Management + Trading active" || echo "disabled — Token Management + Trading hidden")${RESET}"
printf "${CYAN}│${RESET}\n"

# ─────────────────────────────────────────────────────────────────────────────
# Confirm & write
# ─────────────────────────────────────────────────────────────────────────────
PROCEED="yes"
confirm PROCEED "Write .env and continue?" "Y"

if [[ "$PROCEED" != "yes" ]]; then
  printf "\n${YELLOW}Setup cancelled. Nothing was written.${RESET}\n\n"
  exit 0
fi

divider

# ─────────────────────────────────────────────────────────────────────────────
# Write .env
# ─────────────────────────────────────────────────────────────────────────────
_raw_uid=$(id -u 2>/dev/null || echo "1000")
if (( _raw_uid < 1000 )); then
  ML_USER_ID=1000
else
  ML_USER_ID=$_raw_uid
fi
_raw_gid=$(id -g 2>/dev/null || echo "1000")
if (( _raw_gid < 1000 )); then
  ML_GROUP_ID=1000
else
  ML_GROUP_ID=$_raw_gid
fi

INDEXER_ENABLED=$([ "$ENABLE_INDEXER" == "yes" ] && echo "true" || echo "false")
ENABLE_HTTPS=$([ "$HTTPS_SETUP" == "yes" ] && echo "true" || echo "false")

WALLET_RPC_CMD="wallet-rpc-daemon ${NETWORK}"

cat > .env <<EOF
# Generated by init.sh on $(date)
# ─────────────────────────────────────────

# Network: mainnet | testnet
NETWORK=${NETWORK}

# Docker user/group IDs
ML_USER_ID=${ML_USER_ID}
ML_GROUP_ID=${ML_GROUP_ID}

# Full wallet-rpc-daemon command (includes network + optional --wallet-file)
# Edit this line to change wallet file or network, then restart wallet-rpc-daemon.
WALLET_RPC_CMD=${WALLET_RPC_CMD}

# Node RPC credentials
NODE_RPC_USERNAME=${NODE_RPC_USERNAME}
NODE_RPC_PASSWORD=${NODE_RPC_PASSWORD}

# Wallet RPC credentials
WALLET_RPC_USERNAME=${WALLET_RPC_USERNAME}
WALLET_RPC_PASSWORD=${WALLET_RPC_PASSWORD}

# Indexer-dependent features (Token Management, Trading)
INDEXER_ENABLED=${INDEXER_ENABLED}

# Web UI authentication (generated by init.sh — do NOT edit manually)
UI_PASSWORD_HASH=${UI_PASSWORD_HASH}
UI_TOTP_SECRET=${UI_TOTP_SECRET}
SESSION_SECRET=${SESSION_SECRET}

# IPFS storage provider: filebase | pinata (empty = disabled)
IPFS_PROVIDER=${IPFS_PROVIDER}
FILEBASE_TOKEN=${FILEBASE_TOKEN}
PINATA_JWT=${PINATA_JWT}

# Rust log level
RUST_LOG=info

# Indexer stack (only used with --profile indexer)
POSTGRES_USER=mintlayer
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
POSTGRES_DB=mintlayer

# HTTPS via Caddy (only used with --profile https)
ENABLE_HTTPS=${ENABLE_HTTPS}
DOMAIN=${DOMAIN}
DUCKDNS_SUBDOMAIN=${DUCKDNS_SUBDOMAIN}
DUCKDNS_TOKEN=${DUCKDNS_TOKEN}
EOF

ok ".env written"

# ── Create data directory ─────────────────────────────────────────────────────
mkdir -p mintlayer-data
ok "mintlayer-data/ directory ready"

# ─────────────────────────────────────────────────────────────────────────────
# Start services?
# ─────────────────────────────────────────────────────────────────────────────
printf "${CYAN}│${RESET}\n"
START="yes"
confirm START "Start services now with docker compose?" "Y"

COMPOSE=$(compose_cmd)

if [[ "$START" == "yes" ]]; then
  printf "${CYAN}│${RESET}\n"
  hint "Pulling images and starting containers..."
  printf "${CYAN}│${RESET}\n"

  PROFILES=""
  if [[ "$ENABLE_INDEXER" == "yes" ]]; then
    PROFILES="$PROFILES --profile indexer"
  fi
  if [[ "$HTTPS_SETUP" == "yes" ]]; then
    PROFILES="$PROFILES --profile https"
    if [[ -n "$DUCKDNS_SUBDOMAIN" ]]; then
      PROFILES="$PROFILES --profile duckdns"
    fi
  fi

  $COMPOSE pull --quiet
  $COMPOSE $PROFILES up -d

  ok "Services started"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Apply firewall rules
# ─────────────────────────────────────────────────────────────────────────────
if [[ "$SETUP_FIREWALL" == "yes" ]]; then
  printf "${CYAN}│${RESET}\n"
  hint "Applying firewall rules..."

  _sudo=""
  if [ "$(id -u)" -ne 0 ]; then _sudo="sudo"; fi

  if command -v ufw &>/dev/null; then
    $_sudo ufw --force reset     >/dev/null 2>&1
    $_sudo ufw default deny incoming  >/dev/null 2>&1
    $_sudo ufw default allow outgoing >/dev/null 2>&1
    $_sudo ufw allow 22/tcp      >/dev/null 2>&1
    $_sudo ufw allow 80/tcp      >/dev/null 2>&1
    $_sudo ufw allow 443/tcp     >/dev/null 2>&1
    $_sudo ufw --force enable    >/dev/null 2>&1
    ok "ufw enabled — SSH (22), HTTP (80), HTTPS (443) allowed"
  elif command -v firewall-cmd &>/dev/null; then
    $_sudo firewall-cmd --set-default-zone=drop           >/dev/null 2>&1
    $_sudo firewall-cmd --permanent --add-service=ssh     >/dev/null 2>&1
    $_sudo firewall-cmd --permanent --add-service=http    >/dev/null 2>&1
    $_sudo firewall-cmd --permanent --add-service=https   >/dev/null 2>&1
    $_sudo firewall-cmd --reload                          >/dev/null 2>&1
    ok "firewalld enabled — SSH, HTTP, HTTPS allowed"
  fi
fi

divider

# ─────────────────────────────────────────────────────────────────────────────
# Next steps
# ─────────────────────────────────────────────────────────────────────────────
printf "\n"
printf "${GREEN}${BOLD}  Setup complete!${RESET}\n"
printf "\n"

printf "  ${BOLD}Next steps${RESET}\n\n"

printf "  ${YELLOW}1.${RESET} Create your wallet via the web UI:\n"
if [[ "$HTTPS_SETUP" == "yes" ]]; then
  printf "     ${CYAN}https://${DOMAIN}/setup${RESET}\n\n"
else
  printf "     ${CYAN}http://<your-server-ip>:4321/setup${RESET}\n\n"
fi
printf "  ${YELLOW}2.${RESET} Then point the daemon at the new file — edit ${GRAY}.env${RESET}:\n"
printf "     ${GRAY}WALLET_RPC_CMD=wallet-rpc-daemon ${NETWORK} --wallet-file /home/mintlayer/<filename>${RESET}\n\n"
printf "  ${YELLOW}3.${RESET} Restart the wallet daemon:\n"
printf "     ${GRAY}${COMPOSE} restart wallet-rpc-daemon${RESET}\n\n"

printf "  ${DIM}Other useful commands:${RESET}\n"
printf "  ${GRAY}${COMPOSE} logs -f wallet-rpc-daemon   # watch wallet daemon logs${RESET}\n"
printf "  ${GRAY}${COMPOSE} run --rm wallet-cli         # interactive CLI${RESET}\n"
printf "  ${GRAY}${COMPOSE} down                        # stop everything${RESET}\n"
printf "\n"
printf "  ${DIM}Note: mainnet sync takes hours on first run.${RESET}\n"
printf "  ${DIM}Balance and history appear once the node is fully synced.${RESET}\n"
printf "\n"
