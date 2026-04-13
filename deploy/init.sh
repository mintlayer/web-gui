#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Mintlayer Web GUI — remote installer
# Served at https://www.mintlayer.org/get/init.sh
# Usage: bash <(curl -sSL https://www.mintlayer.org/get/init.sh)
# ─────────────────────────────────────────────────────────────────────────────

BASE_URL="https://www.mintlayer.org/get"

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

# ── Bootstrap: download compose file if not already present ───────────────────
bootstrap_remote() {
  if [[ -f docker-compose.yml ]]; then
    return
  fi

  printf "\n"
  printf "${CYAN}◆${RESET} ${BOLD}Install location${RESET}\n"
  printf "${GRAY}│  Where should Mintlayer Web GUI be installed?${RESET}\n"
  printf "${CYAN}│${RESET}  Directory: ${GRAY}(${HOME}/mintlayer-gui)${RESET} "
  read -r input
  INSTALL_DIR="${input:-${HOME}/mintlayer-gui}"

  mkdir -p "$INSTALL_DIR"
  cd "$INSTALL_DIR"

  printf "${GRAY}│  Downloading docker-compose.yml...${RESET}\n"
  if ! curl -fsSL "${BASE_URL}/docker-compose.yml" -o docker-compose.yml; then
    err "Failed to download docker-compose.yml from ${BASE_URL}"
    exit 1
  fi
  ok "Files downloaded to ${INSTALL_DIR}"
  printf "${GRAY}└─────────────────────────────────────────${RESET}\n"
}

# ── Docker install instructions (Linux only) ──────────────────────────────────
docker_install_hint() {
  printf "\n"
  printf "${BOLD}  Install Docker Engine on Linux:${RESET}\n"
  printf "  Ubuntu/Debian:\n"
  printf "    curl -fsSL https://get.docker.com | sh\n"
  printf "    sudo usermod -aG docker \$USER   # then log out and back in\n"
  printf "\n"
  printf "  Or follow the official guide for your distro:\n"
  printf "  https://docs.docker.com/engine/install/\n"
  printf "\n"
  printf "  After installing, re-run this script.\n"
  printf "\n"
}

# ── Prerequisite checks ───────────────────────────────────────────────────────
check_prereqs() {
  if ! command -v docker &>/dev/null; then
    err "Docker is not installed or not in PATH."
    docker_install_hint
    exit 1
  fi

  if ! docker info &>/dev/null 2>&1; then
    err "Docker is installed but the daemon is not running."
    printf "  ${YELLOW}▲${RESET}  Run: ${GRAY}sudo systemctl start docker${RESET}\n\n"
    exit 1
  fi

  if ! docker compose version &>/dev/null 2>&1 && ! command -v docker-compose &>/dev/null; then
    err "Docker Compose is not available."
    printf "  Install with: ${GRAY}sudo apt install docker-compose-plugin${RESET}\n"
    printf "  Or see: https://docs.docker.com/compose/install/\n\n"
    exit 1
  fi

  command -v python3 &>/dev/null || {
    err "Python 3 is not installed (required for password hashing)."
    printf "  Install with: ${GRAY}sudo apt install python3${RESET}\n\n"
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
# Step 2 — Wallet
# ─────────────────────────────────────────────────────────────────────────────
step "Wallet"
hint "The wallet-rpc-daemon opens one wallet file at a time."
hint "Wallet files live in ./mintlayer-data/ (mapped to /home/mintlayer/ inside containers)."
hint ""

WALLET_CHOICE=""
choose WALLET_CHOICE "Do you have an existing wallet file to load?" \
  "No — I'll create a new wallet via the web UI after starting" \
  "Yes — I have a wallet file to load on startup"

WALLET_FILE=""
case "$WALLET_CHOICE" in
  "Yes — I have a wallet file to load on startup")
    ask "Existing wallet filename"
    hint "Copy the file into ./mintlayer-data/ before starting."
    hint "Enter only the filename, not the full path."
    prompt WALLET_FILE "Filename:" "wallet"
    WALLET_ACTION="existing"
    warn "Remember to copy your wallet file to ./mintlayer-data/${WALLET_FILE} before starting."
    ;;
  *)
    WALLET_ACTION="create"
    hint "The daemon will start without a wallet loaded."
    hint "Go to http://<your-server-ip>:<port>/setup to create your wallet, then"
    hint "update WALLET_RPC_CMD in .env and restart: docker compose restart wallet-rpc-daemon"
    ;;
esac

divider

# ─────────────────────────────────────────────────────────────────────────────
# Step 3 — Passwords
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
# Step 4 — Web UI access (password + TOTP 2FA)
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
key = hashlib.pbkdf2_hmac('sha512', password.encode(), bytes.fromhex(salt), 100000)
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

# Show QR code if qrencode is available, otherwise show the URI
if command -v qrencode &>/dev/null; then
  echo "$TOTP_URI" | qrencode -t ANSIUTF8 | sed "s/^/${CYAN}│${RESET}  /"
else
  printf "${CYAN}│${RESET}  ${GRAY}%s${RESET}\n" "$TOTP_URI"
  printf "${CYAN}│${RESET}\n"
  printf "${CYAN}│${RESET}  ${DIM}(Install qrencode for a scannable QR code in the terminal)${RESET}\n"
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
# Step 5 — Web GUI port
# ─────────────────────────────────────────────────────────────────────────────
step "Web interface"

ask "Port for the web GUI"
hint "The web interface will be available at http://<your-server-ip>:<port>"
prompt WEB_GUI_PORT "Port:" "4321"

while ! [[ "$WEB_GUI_PORT" =~ ^[0-9]+$ ]] || (( WEB_GUI_PORT < 1 || WEB_GUI_PORT > 65535 )); do
  printf "${CYAN}│${RESET}  ${RED}Enter a valid port number (1-65535)${RESET}\n"
  prompt WEB_GUI_PORT "Port:" "4321"
done

divider

# ─────────────────────────────────────────────────────────────────────────────
# Step 6 — IPFS Storage Provider (optional)
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
  "None — disable IPFS uploads" \
  "Filebase (recommended — 5 GB free, always public)" \
  "Pinata (paid account required to make files public)"

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
# Step 7 — Indexer (optional)
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
API_WEB_SERVER_PORT="3000"
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

  ask "Port for the blockchain REST API"
  prompt API_WEB_SERVER_PORT "Port:" "3000"
fi

divider

# ─────────────────────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────────────────────
printf "\n"
step "Summary"
printf "${CYAN}│${RESET}\n"
printf "${CYAN}│${RESET}  %-22s %s\n" "Network:"           "${BOLD}${NETWORK}${RESET}"

wallet_summary="${BOLD}none — create via web UI at /setup${RESET}"
if [[ -n "$WALLET_FILE" && "$WALLET_ACTION" == "existing" ]]; then
  wallet_summary="${BOLD}${WALLET_FILE}${RESET} ${GRAY}(./mintlayer-data/${WALLET_FILE})${RESET}"
fi
printf "${CYAN}│${RESET}  %-22s ${wallet_summary}\n" "Wallet:"

printf "${CYAN}│${RESET}  %-22s %s\n" "Passwords:"  "${BOLD}$([ "$USE_RANDOM_PASSWORDS" == "yes" ] && echo "randomly generated" || echo "custom")${RESET}"
printf "${CYAN}│${RESET}  %-22s %s\n" "Web UI auth:"  "${BOLD}password + TOTP 2FA${RESET}"
printf "${CYAN}│${RESET}  %-22s %s\n" "Web GUI:"    "${BOLD}http://<your-server-ip>:${WEB_GUI_PORT}${RESET}"
printf "${CYAN}│${RESET}  %-22s %s\n" "IPFS storage:" "${BOLD}$([ -n "$IPFS_PROVIDER" ] && echo "$IPFS_PROVIDER" || echo "disabled — token/NFT uploads disabled")${RESET}"
printf "${CYAN}│${RESET}  %-22s %s\n" "Indexer:"    "${BOLD}$([ "$ENABLE_INDEXER" == "yes" ] && echo "enabled (port ${API_WEB_SERVER_PORT}) — Token Management + Trading active" || echo "disabled — Token Management + Trading hidden")${RESET}"
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
ML_USER_ID=$(id -u 2>/dev/null || echo "1000")
_raw_gid=$(id -g 2>/dev/null || echo "1000")
if (( _raw_gid < 1000 )); then
  ML_GROUP_ID=1000
else
  ML_GROUP_ID=$_raw_gid
fi

INDEXER_ENABLED=$([ "$ENABLE_INDEXER" == "yes" ] && echo "true" || echo "false")

if [[ -n "$WALLET_FILE" ]]; then
  WALLET_RPC_CMD="wallet-rpc-daemon ${NETWORK} --wallet-file /home/mintlayer/${WALLET_FILE}"
else
  WALLET_RPC_CMD="wallet-rpc-daemon ${NETWORK}"
fi

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

# Web GUI port
WEB_GUI_PORT=${WEB_GUI_PORT}

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
API_WEB_SERVER_PORT=${API_WEB_SERVER_PORT}
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
    PROFILES="--profile indexer"
  fi

  $COMPOSE pull --quiet
  $COMPOSE $PROFILES up -d

  ok "Services started"
fi

divider

# ─────────────────────────────────────────────────────────────────────────────
# Next steps
# ─────────────────────────────────────────────────────────────────────────────
printf "\n"
printf "${GREEN}${BOLD}  Setup complete!${RESET}\n"
printf "\n"

printf "  ${BOLD}Next steps${RESET}\n\n"

if [[ "$WALLET_ACTION" == "existing" && -n "$WALLET_FILE" ]]; then
  printf "  ${YELLOW}1.${RESET} Copy your wallet file into the data directory:\n"
  printf "     ${GRAY}cp /path/to/your/wallet ./mintlayer-data/${WALLET_FILE}${RESET}\n\n"
  printf "  ${YELLOW}2.${RESET} Open the dashboard:\n"
  printf "     ${CYAN}http://<your-server-ip>:${WEB_GUI_PORT}${RESET}\n\n"
else
  printf "  ${YELLOW}1.${RESET} Create your wallet via the web UI:\n"
  printf "     ${CYAN}http://<your-server-ip>:${WEB_GUI_PORT}/setup${RESET}\n\n"
  printf "  ${YELLOW}2.${RESET} Then point the daemon at the new file — edit ${GRAY}.env${RESET}:\n"
  printf "     ${GRAY}WALLET_RPC_CMD=wallet-rpc-daemon ${NETWORK} --wallet-file /home/mintlayer/<filename>${RESET}\n\n"
  printf "  ${YELLOW}3.${RESET} Restart the wallet daemon:\n"
  printf "     ${GRAY}${COMPOSE} restart wallet-rpc-daemon${RESET}\n\n"
fi

printf "  ${DIM}Other useful commands:${RESET}\n"
printf "  ${GRAY}${COMPOSE} logs -f wallet-rpc-daemon   # watch wallet daemon logs${RESET}\n"
printf "  ${GRAY}${COMPOSE} run --rm wallet-cli         # interactive CLI${RESET}\n"
printf "  ${GRAY}${COMPOSE} down                        # stop everything${RESET}\n"
printf "\n"
printf "  ${DIM}Note: mainnet sync takes hours on first run.${RESET}\n"
printf "  ${DIM}Balance and history appear once the node is fully synced.${RESET}\n"
printf "\n"
