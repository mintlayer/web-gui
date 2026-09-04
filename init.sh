#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Mintlayer Web GUI — interactive setup
# Inspired by the Astro create CLI style
# ─────────────────────────────────────────────────────────────────────────────

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

# ── Detect OS ─────────────────────────────────────────────────────────────────
detect_os() {
  case "$(uname -s)" in
    Darwin) echo "macos" ;;
    Linux)
      if grep -qi microsoft /proc/version 2>/dev/null; then
        echo "wsl"
      else
        echo "linux"
      fi
      ;;
    MINGW*|MSYS*|CYGWIN*) echo "windows" ;;
    *) echo "unknown" ;;
  esac
}

# ── Docker install instructions ───────────────────────────────────────────────
docker_install_hint() {
  local os
  os=$(detect_os)
  printf "\n"
  case "$os" in
    macos)
      printf "${BOLD}  Install Docker Desktop for Mac:${RESET}\n"
      printf "  1. Download from https://docs.docker.com/desktop/install/mac-install/\n"
      printf "  2. Open the .dmg and drag Docker to Applications\n"
      printf "  3. Launch Docker Desktop and wait for the whale icon to stop animating\n"
      printf "  4. Re-run this script\n"
      ;;
    wsl)
      printf "${BOLD}  Install Docker Desktop for Windows (with WSL 2 backend):${RESET}\n"
      printf "  1. Download from https://docs.docker.com/desktop/install/windows-install/\n"
      printf "  2. Enable 'Use the WSL 2 based engine' in Docker Desktop settings\n"
      printf "  3. Ensure your WSL distro is enabled under Resources → WSL Integration\n"
      printf "  4. Re-run this script inside WSL\n"
      ;;
    windows)
      printf "${BOLD}  Install Docker Desktop for Windows:${RESET}\n"
      printf "  1. Download from https://docs.docker.com/desktop/install/windows-install/\n"
      printf "  2. Run the installer and follow the prompts\n"
      printf "  3. Re-run this script\n"
      ;;
    linux)
      printf "${BOLD}  Install Docker Engine on Linux:${RESET}\n"
      printf "  Ubuntu/Debian:\n"
      printf "    curl -fsSL https://get.docker.com | sh\n"
      printf "    sudo usermod -aG docker \$USER   # then log out and back in\n"
      printf "\n"
      printf "  Or follow the official guide for your distro:\n"
      printf "  https://docs.docker.com/engine/install/\n"
      printf "\n"
      printf "  After installing, re-run this script.\n"
      ;;
    *)
      printf "  Visit https://docs.docker.com/get-docker/ for installation instructions.\n"
      ;;
  esac
  printf "\n"
}

# ── Prerequisite checks ───────────────────────────────────────────────────────
check_prereqs() {
  # Check Docker first — give OS-specific install instructions if missing
  if ! command -v docker &>/dev/null; then
    err "Docker is not installed or not in PATH."
    docker_install_hint
    exit 1
  fi

  # Docker found — make sure the daemon is actually running
  if ! docker info &>/dev/null 2>&1; then
    err "Docker is installed but the daemon is not running."
    local os
    os=$(detect_os)
    case "$os" in
      macos|windows) printf "  ${YELLOW}▲${RESET}  Start Docker Desktop and wait for it to finish loading, then re-run this script.\n\n" ;;
      wsl)           printf "  ${YELLOW}▲${RESET}  Start Docker Desktop on Windows (WSL backend), then re-run this script.\n\n" ;;
      linux)         printf "  ${YELLOW}▲${RESET}  Run: ${GRAY}sudo systemctl start docker${RESET}\n\n" ;;
    esac
    exit 1
  fi

  # Accept both "docker compose" (v2) and "docker-compose" (v1)
  if ! docker compose version &>/dev/null 2>&1 && ! command -v docker-compose &>/dev/null; then
    err "Docker Compose is not available."
    printf "  Docker Compose v2 ships with Docker Desktop.\n"
    printf "  On Linux, install it with: ${GRAY}sudo apt install docker-compose-plugin${RESET}\n"
    printf "  Or see: https://docs.docker.com/compose/install/\n\n"
    exit 1
  fi

  command -v node &>/dev/null || {
    err "Node.js is not installed (required for password hashing)."
    printf "  Install Node.js v18+ from https://nodejs.org or via your package manager.\n\n"
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

check_prereqs

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
UI_PASSWORD_HASH=$(node -e "
  const c = require('crypto');
  const salt = c.randomBytes(32).toString('hex');
  c.pbkdf2(process.argv[1], salt, 210000, 64, 'sha512', (err, key) => {
    if (err) { process.stderr.write(err.message + '\n'); process.exit(1); }
    process.stdout.write('pbkdf2:sha512:210000:' + salt + ':' + key.toString('hex'));
  });
" "$UI_PASSWORD")
ok "Password hashed"

# Generate TOTP secret (20 random bytes → base32)
UI_TOTP_SECRET=$(node -e "
  const bytes = require('crypto').randomBytes(20);
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let result = '', bits = 0, value = 0;
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      result += alpha[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) result += alpha[(value << (5 - bits)) & 31];
  process.stdout.write(result);
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
  # Re-display the URI in case they need it again
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
# Step 4 — Web GUI port
# ─────────────────────────────────────────────────────────────────────────────
step "Web interface"

ask "Port for the web GUI"
hint "The Astro web interface will be available at http://localhost:<port>"
prompt WEB_GUI_PORT "Port:" "4321"

# Validate it's a number
while ! [[ "$WEB_GUI_PORT" =~ ^[0-9]+$ ]] || (( WEB_GUI_PORT < 1 || WEB_GUI_PORT > 65535 )); do
  printf "${CYAN}│${RESET}  ${RED}Enter a valid port number (1-65535)${RESET}\n"
  prompt WEB_GUI_PORT "Port:" "4321"
done

ask "Expose the web GUI to your network?"
hint "Three access modes:"
hint "  localhost only — the GUI is reachable solely from this machine;"
hint "    open it through an SSH tunnel. Most secure."
hint "  LAN over HTTPS — other devices open it at https://<hostname>; Caddy"
hint "    terminates TLS with a local Certificate Authority (works without a"
hint "    public domain). Browsers warn once until you import the CA root,"
hint "    downloadable from Settings -> HTTPS after setup."
hint "  LAN plain HTTP — not recommended: traffic is unencrypted and the"
hint "    session cookie is refused on non-localhost origins, so sign-in only"
hint "    works from this machine anyway."
hint "Running your own TLS proxy on a public domain? Pick 'localhost only'"
hint "and set WEB_GUI_HOST + PASSKEY_* in .env manually (see .env.example)."
ACCESS_CHOICE=""
choose ACCESS_CHOICE "Access mode:" \
  "localhost only (SSH tunnel)" \
  "LAN over HTTPS (Caddy local CA)" \
  "LAN plain HTTP (not recommended)"

WEB_GUI_TLS="false"
WEB_GUI_BIND="127.0.0.1"
WEB_GUI_HOST="localhost"
case "$ACCESS_CHOICE" in
  *"LAN over HTTPS"*)
    WEB_GUI_TLS="true"
    ask "Hostname for the HTTPS certificate"
    hint "Must resolve to this machine from your devices, e.g. ml1.local"
    hint "(mDNS) or an entry in your router's DNS / your device's hosts file."
    prompt WEB_GUI_HOST "Hostname:" "$(hostname -s 2>/dev/null || echo mintlayer-gui).local"
    # Hostname flows into the Caddyfile (pre-parse textual substitution),
    # docker-compose env interpolation, and the WebAuthn RP ID — so it must
    # be a plain lowercase DNS name. Uppercase is normalized; everything
    # else invalid is re-asked.
    while ! [[ "${WEB_GUI_HOST,,}" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$ ]]; do
      printf "${CYAN}│${RESET}  ${RED}Enter a valid hostname (letters, digits, dots, hyphens — no ports, spaces or underscores)${RESET}\n"
      prompt WEB_GUI_HOST "Hostname:" "$(hostname -s 2>/dev/null || echo mintlayer-gui).local"
    done
    WEB_GUI_HOST="${WEB_GUI_HOST,,}"
    warn "The GUI stays bound to 127.0.0.1 — only the HTTPS gateway (port 443) is exposed."
    hint "Always open https://${WEB_GUI_HOST} — plain http:// (port 80) is not published."
    ;;
  *"LAN plain HTTP"*)
    WEB_GUI_BIND="0.0.0.0"
    warn "GUI will be reachable from other machines (plain HTTP)."
    warn "Login requires a Secure session cookie, which browsers refuse on"
    warn "plain HTTP for non-localhost origins — sign-in works only locally."
    ;;
  *)
    ;;
esac

# Passkeys (WebAuthn) need a proper DNS hostname — they never work from raw
# IPs. The HTTPS mode implies one; localhost/plain-HTTP keep passkeys off.

# Derive passkey config from hostname
if [[ -z "$WEB_GUI_HOST" || "$WEB_GUI_HOST" == "localhost" ]]; then
  WEB_GUI_HOST="localhost"
  PASSKEY_RP_ID="localhost"
  PASSKEY_ORIGIN="http://localhost:${WEB_GUI_PORT}"
else
  PASSKEY_RP_ID="${WEB_GUI_HOST}"
  PASSKEY_ORIGIN="https://${WEB_GUI_HOST}"
fi

divider

# ─────────────────────────────────────────────────────────────────────────────
# Step 5 — Indexer
# ─────────────────────────────────────────────────────────────────────────────
step "Indexer stack"
hint "The indexer adds PostgreSQL + blockchain scanner + REST API."
hint "It enables Token Management and Trading in the web UI."
hint "Requires more disk space and memory."
hint ""
hint "Disable it only if you don't need to issue tokens or trade."
hint "Staking, sending, and receiving work fine without it."
hint ""

ENABLE_INDEXER="yes"
confirm ENABLE_INDEXER "Enable the indexer? (disable only if you don't need Token Management or Trading)" "Y"

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
# Step — Bitcoin node + BTC wallet (optional)
# ─────────────────────────────────────────────────────────────────────────────
step "Bitcoin node + BTC wallet (optional)"
hint "Adds a Bitcoin Core node and a built-in BTC wallet to the web UI"
hint "(balance, receive, send). The wallet keys are held by a light-wallet"
hint "sidecar; the node only provides chain data and broadcasts transactions."
hint ""
hint "Requirements: extra disk space (mainnet ~700 GB) and a full initial"
hint "sync that can take days. The BTC wallet is a HOT wallet - keep only"
hint "spending amounts there."
hint ""

ENABLE_BITCOIN="no"
confirm ENABLE_BITCOIN "Enable the Bitcoin node + BTC wallet?" "N"

BITCOIN_RPC_USERNAME="bitcoin_user"
BITCOIN_RPC_PASSWORD=""
BITCOIN_WALLET_HTTP_USERNAME="btcwallet_user"
BITCOIN_WALLET_HTTP_PASSWORD=""
BITCOIN_NETWORK=""
if [[ "$ENABLE_BITCOIN" == "yes" ]]; then
  if [[ "$USE_RANDOM_PASSWORDS" == "yes" ]]; then
    BITCOIN_RPC_PASSWORD=$(rand_pass)
    BITCOIN_WALLET_HTTP_PASSWORD=$(rand_pass)
    ok "Generated random Bitcoin RPC passwords (saved to .env)"
  else
    ask "Bitcoin node RPC password"
    prompt_secret BITCOIN_RPC_PASSWORD "Password:"
    while [[ ${#BITCOIN_RPC_PASSWORD} -lt 8 ]]; do
      printf "${CYAN}│${RESET}  ${RED}Password must be at least 8 characters${RESET}\n"
      prompt_secret BITCOIN_RPC_PASSWORD "Password:"
    done
    ask "BTC wallet API password"
    prompt_secret BITCOIN_WALLET_HTTP_PASSWORD "Password:"
    while [[ ${#BITCOIN_WALLET_HTTP_PASSWORD} -lt 8 ]]; do
      printf "${CYAN}│${RESET}  ${RED}Password must be at least 8 characters${RESET}\n"
      prompt_secret BITCOIN_WALLET_HTTP_PASSWORD "Password:"
    done
  fi

  ask "Bitcoin network"
  hint "Leave default to follow the Mintlayer network (${NETWORK})."
  prompt BITCOIN_NETWORK "Network (mainnet/testnet/regtest/signet):" ""
  case "$BITCOIN_NETWORK" in
    ""|"mainnet"|"testnet"|"regtest"|"signet") ;;
    *) hint "Unknown network '${BITCOIN_NETWORK}' - following Mintlayer network instead."; BITCOIN_NETWORK="" ;;
  esac

  ask "Blockchain storage mode"
  hint "FULL mode keeps the whole chain plus a transaction index: complete"
  hint "wallet history and rescans of any restored seed."
  hint "  mainnet ~700 GB of disk - testnet ~50 GB"
  hint "PRUNED mode keeps only recent blocks (~15-25 GB on mainnet). The BTC"
  hint "wallet you create in the GUI works normally, but restoring an old"
  hint "seed cannot rescan ancient history."
  BTC_PRUNED="yes"
  confirm BTC_PRUNED "Run the Bitcoin node in pruned mode?" "Y"
fi

divider

# ─────────────────────────────────────────────────────────────────────────────
# Step — Auto-update (Watchtower)
# ─────────────────────────────────────────────────────────────────────────────
step "Auto-update (Watchtower)"
hint "Watchtower checks Docker Hub daily at 04:00 and automatically pulls new"
hint "versions of the Mintlayer images (node, wallet, indexer) then restarts"
hint "only the affected containers."
hint "The web GUI (built locally) is never touched by Watchtower."
hint ""

ENABLE_WATCHTOWER="no"
confirm ENABLE_WATCHTOWER "Enable automatic image updates?" "Y"

WATCHTOWER_NOTIFICATION_URL=""
if [[ "$ENABLE_WATCHTOWER" == "yes" ]]; then
  ask "Telegram notification on update (optional)"
  hint "Get a message when an image is updated."
  hint "Format: telegram://BOT_TOKEN@telegram?channels=CHAT_ID"
  hint "Leave blank to skip."
  prompt WATCHTOWER_NOTIFICATION_URL "Notification URL:" ""
fi

divider

# ─────────────────────────────────────────────────────────────────────────────
# Step — IPFS Storage (optional)
# ─────────────────────────────────────────────────────────────────────────────
step "IPFS Storage (optional)"
hint "Enables automatic upload of token/NFT images and metadata to IPFS."
hint "Without this, URLs can still be entered manually — you can configure this"
hint "later in the web UI Settings page."
hint ""

SETUP_IPFS="no"
confirm SETUP_IPFS "Configure IPFS now?" "N"

IPFS_PROVIDER=""
FILEBASE_TOKEN=""
PINATA_JWT=""

if [[ "$SETUP_IPFS" == "yes" ]]; then
  hint "  Filebase — 5 GB free, always public — https://filebase.com"
  hint "  Pinata   — requires paid plan for public files — https://app.pinata.cloud"
  hint ""

  IPFS_CHOICE=""
  choose IPFS_CHOICE "Choose IPFS provider:" \
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
      prompt_secret PINATA_JWT "JWT:"
      while [[ -z "$PINATA_JWT" ]]; do
        printf "${CYAN}│${RESET}  ${RED}JWT cannot be empty${RESET}\n"
        prompt_secret PINATA_JWT "JWT:"
      done
      ok "Pinata JWT saved"
      ;;
  esac
fi

divider

# ─────────────────────────────────────────────────────────────────────────────
# Step — Telegram Notifications (optional)
# ─────────────────────────────────────────────────────────────────────────────
step "Telegram Notifications (optional)"
hint "Receive wallet alerts (payments, staking rewards, node status) via a Telegram bot."
hint "You can configure this later in the web UI Settings page."
hint ""

SETUP_TELEGRAM="no"
confirm SETUP_TELEGRAM "Configure Telegram notifications now?" "N"

TELEGRAM_BOT_TOKEN=""
TELEGRAM_CHAT_ID=""

if [[ "$SETUP_TELEGRAM" == "yes" ]]; then
  hint "1. Create a bot with @BotFather on Telegram"
  hint "2. Start a chat with your bot and send /start"
  hint "3. Use @userinfobot to get your chat ID"
  hint ""
  ask "Telegram bot token"
  prompt_secret TELEGRAM_BOT_TOKEN "Bot token:"
  while [[ -z "$TELEGRAM_BOT_TOKEN" ]]; do
    printf "${CYAN}│${RESET}  ${RED}Bot token cannot be empty${RESET}\n"
    prompt_secret TELEGRAM_BOT_TOKEN "Bot token:"
  done
  ask "Telegram chat ID"
  prompt TELEGRAM_CHAT_ID "Chat ID:"
  while [[ -z "$TELEGRAM_CHAT_ID" ]]; do
    printf "${CYAN}│${RESET}  ${RED}Chat ID cannot be empty${RESET}\n"
    prompt TELEGRAM_CHAT_ID "Chat ID:"
  done
  ok "Telegram configured"
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
printf "${CYAN}│${RESET}  %-22s %s\n" "Web GUI:"    "${BOLD}${PASSKEY_ORIGIN}${RESET}"
printf "${CYAN}│${RESET}  %-22s %s\n" "LAN HTTPS:"   "${BOLD}$([ "$WEB_GUI_TLS" == "true" ] && echo "enabled (${WEB_GUI_HOST}, local CA)" || echo "disabled")${RESET}"
printf "${CYAN}│${RESET}  %-22s %s\n" "Passkeys:"   "${BOLD}$([ "$WEB_GUI_HOST" != "localhost" ] && echo "enabled (${WEB_GUI_HOST})" || echo "localhost only")${RESET}"
printf "${CYAN}│${RESET}  %-22s %s\n" "Indexer:"      "${BOLD}$([ "$ENABLE_INDEXER" == "yes" ] && echo "enabled (port ${API_WEB_SERVER_PORT}) — Token Management + Trading active" || echo "disabled — Token Management + Trading hidden")${RESET}"
printf "${CYAN}│${RESET}  %-22s %s\n" "Bitcoin:"     "${BOLD}$([ "$ENABLE_BITCOIN" == "yes" ] && echo "enabled (node + BTC wallet)" || echo "disabled")${RESET}"
printf "${CYAN}│${RESET}  %-22s %s\n" "IPFS storage:" "${BOLD}$([ -n "$IPFS_PROVIDER" ] && echo "$IPFS_PROVIDER" || echo "disabled — configure later in Settings")${RESET}"
printf "${CYAN}│${RESET}  %-22s %s\n" "Telegram:"     "${BOLD}$([ -n "$TELEGRAM_BOT_TOKEN" ] && echo "configured" || echo "disabled — configure later in Settings")${RESET}"
printf "${CYAN}│${RESET}  %-22s %s\n" "Auto-update:"  "${BOLD}$([ "$ENABLE_WATCHTOWER" == "yes" ] && echo "enabled (daily at 04:00)" || echo "disabled")${RESET}"
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

# Get current user/group IDs for the container's mintlayer user.
# GIDs below 1000 are reserved system groups on Linux and may already exist
# inside the container (e.g. macOS 'staff' GID 20 = Linux 'dialout' GID 20).
# Use 1000 in that case — it's the standard unprivileged GID on Linux.
ML_USER_ID=$(id -u 2>/dev/null || echo "1000")
_raw_gid=$(id -g 2>/dev/null || echo "1000")
if (( _raw_gid < 1000 )); then
  ML_GROUP_ID=1000
else
  ML_GROUP_ID=$_raw_gid
fi

# Derive boolean flags
INDEXER_ENABLED=$([ "$ENABLE_INDEXER" == "yes" ] && echo "true" || echo "false")
BITCOIN_ENABLED=$([ "$ENABLE_BITCOIN" == "yes" ] && echo "true" || echo "false")
# Pruned mode: no txindex, keep a small recent-block window. Incompatible
# with each other by design (Bitcoin Core refuses txindex + prune).
if [[ "$ENABLE_BITCOIN" == "yes" && "$BTC_PRUNED" == "yes" ]]; then
  BITCOIN_TXINDEX=0
  BITCOIN_PRUNE=550
else
  BITCOIN_TXINDEX=1
  BITCOIN_PRUNE=0
fi

# Bitcoin Core's -chain flag wants "main" for mainnet ("mainnet" is
# rejected with CreateBaseChainParams). Other network names pass through.
BITCOIN_CORE_CHAIN="main"
if [[ -n "$BITCOIN_NETWORK" && "$BITCOIN_NETWORK" != "mainnet" ]]; then
  BITCOIN_CORE_CHAIN="$BITCOIN_NETWORK"
fi

# Build the full wallet-rpc-daemon command (avoids shell expansion tricks in docker-compose)
WALLET_RPC_CMD="wallet-rpc-daemon ${NETWORK}"

cat > .env <<EOF
# Generated by init.sh on $(date)
# ─────────────────────────────────────────

# Network: mainnet | testnet
NETWORK=${NETWORK}

# Docker user/group IDs
ML_USER_ID=${ML_USER_ID}
ML_GROUP_ID=${ML_GROUP_ID}

# wallet-rpc-daemon command (network only — wallet files are managed via the web UI)
WALLET_RPC_CMD="${WALLET_RPC_CMD}"

# Node RPC credentials
NODE_RPC_USERNAME=${NODE_RPC_USERNAME}
NODE_RPC_PASSWORD=${NODE_RPC_PASSWORD}

# Wallet RPC credentials
WALLET_RPC_USERNAME=${WALLET_RPC_USERNAME}
WALLET_RPC_PASSWORD=${WALLET_RPC_PASSWORD}

# Web GUI
WEB_GUI_PORT=${WEB_GUI_PORT}
WEB_GUI_HOST=${WEB_GUI_HOST}
# Bind address for the GUI port: 127.0.0.1 (default) or 0.0.0.0 (opted in above)
WEB_GUI_BIND=${WEB_GUI_BIND}

# LAN HTTPS gateway (Caddy local CA, profile: web)
WEB_GUI_TLS=${WEB_GUI_TLS}

# Passkeys (WebAuthn) — derived from WEB_GUI_HOST above
# Override these if running behind a reverse proxy that changes the visible hostname.
PASSKEY_RP_ID=${PASSKEY_RP_ID}
PASSKEY_ORIGIN=${PASSKEY_ORIGIN}

# Indexer-dependent features (Token Management, Trading)
INDEXER_ENABLED=${INDEXER_ENABLED}

# Session signing secret (generated by init.sh)
SESSION_SECRET=${SESSION_SECRET}

# Watchtower — auto-update Mintlayer images (profile: watchtower)
# telegram://BOT_TOKEN@telegram?channels=CHAT_ID  or leave empty
WATCHTOWER_NOTIFICATION_URL=${WATCHTOWER_NOTIFICATION_URL}

# Rust log level
RUST_LOG=info

# Indexer stack (only used with --profile indexer)
POSTGRES_USER=mintlayer
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
POSTGRES_DB=mintlayer
API_WEB_SERVER_PORT=${API_WEB_SERVER_PORT}

# Bitcoin node + BTC wallet (only used with --profile bitcoin)
BITCOIN_ENABLED=${BITCOIN_ENABLED}
BITCOIN_NETWORK=${BITCOIN_NETWORK}
BITCOIN_CORE_CHAIN=${BITCOIN_CORE_CHAIN}
BITCOIN_RPC_USERNAME=${BITCOIN_RPC_USERNAME}
BITCOIN_RPC_PASSWORD=${BITCOIN_RPC_PASSWORD}
BITCOIN_WALLET_HTTP_USERNAME=${BITCOIN_WALLET_HTTP_USERNAME}
BITCOIN_WALLET_HTTP_PASSWORD=${BITCOIN_WALLET_HTTP_PASSWORD}
BITCOIN_TXINDEX=${BITCOIN_TXINDEX}
BITCOIN_PRUNE=${BITCOIN_PRUNE}
EOF

ok ".env written"

# ── Write credentials to SQLite via temporary alpine container ───────────────
mkdir -p mintlayer-data/prefs mintlayer-data/plugins
{
  echo "CREATE TABLE IF NOT EXISTS prefs (key TEXT PRIMARY KEY, value TEXT NOT NULL);"
  echo "INSERT OR REPLACE INTO prefs VALUES ('auth.password_hash', '\"${UI_PASSWORD_HASH}\"');"
  echo "INSERT OR REPLACE INTO prefs VALUES ('auth.totp_secret',   '\"${UI_TOTP_SECRET}\"');"
  [ -n "$IPFS_PROVIDER"      ] && echo "INSERT OR REPLACE INTO prefs VALUES ('ipfs.provider',       '\"${IPFS_PROVIDER}\"');" || true
  [ -n "$FILEBASE_TOKEN"     ] && echo "INSERT OR REPLACE INTO prefs VALUES ('ipfs.filebase_token', '\"${FILEBASE_TOKEN}\"');" || true
  [ -n "$PINATA_JWT"         ] && echo "INSERT OR REPLACE INTO prefs VALUES ('ipfs.pinata_jwt',     '\"${PINATA_JWT}\"');" || true
  [ -n "$TELEGRAM_BOT_TOKEN" ] && echo "INSERT OR REPLACE INTO prefs VALUES ('telegram.bot_token',  '\"${TELEGRAM_BOT_TOKEN}\"');" || true
  [ -n "$TELEGRAM_CHAT_ID"   ] && echo "INSERT OR REPLACE INTO prefs VALUES ('telegram.chat_id',    '\"${TELEGRAM_CHAT_ID}\"');" || true
} | docker run --rm -i \
    -v "$(pwd)/mintlayer-data/prefs:/prefs" \
    alpine \
    sh -c 'apk add -q --no-progress sqlite >/dev/null 2>&1 && sqlite3 /prefs/mintlayer_prefs.sqlite'
ok "Credentials written to mintlayer-data/prefs/mintlayer_prefs.sqlite"

# ── Create data directories ──────────────────────────────────────────────────
# Pre-created by the host user so bind mounts are not root-owned when the
# containers mount them (Docker creates missing dirs as root).
mkdir -p mintlayer-data
ok "mintlayer-data/ directory ready"

if [[ "$ENABLE_BITCOIN" == "yes" ]]; then
  mkdir -p bitcoin-data bitcoin-wallet-data
  ok "bitcoin-data/ and bitcoin-wallet-data/ ready"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Start services?
# ─────────────────────────────────────────────────────────────────────────────
printf "${CYAN}│${RESET}\n"
START="yes"
confirm START "Start services now with docker compose?" "Y"

COMPOSE=$(compose_cmd)

if [[ "$START" == "yes" ]]; then
  printf "${CYAN}│${RESET}\n"
  hint "Pulling latest images and starting containers..."
  printf "${CYAN}│${RESET}\n"

  PROFILES=""
  if [[ "$ENABLE_INDEXER" == "yes" ]]; then
    PROFILES="$PROFILES --profile indexer"
  fi
  if [[ "$ENABLE_BITCOIN" == "yes" ]]; then
    PROFILES="$PROFILES --profile bitcoin"
  fi
  if [[ "$ENABLE_WATCHTOWER" == "yes" ]]; then
    PROFILES="$PROFILES --profile watchtower"
  fi
  if [[ "$WEB_GUI_TLS" == "true" ]]; then
    PROFILES="$PROFILES --profile web"
  fi

  # Pull the CI-built multi-arch images (amd64+arm64) from ghcr.io and start.
  # Local rebuilds stay available: docker compose build (see README).
  $COMPOSE $PROFILES pull --quiet || {
    hint "Prebuilt image pull failed — falling back to a local build."
    $COMPOSE $PROFILES build
  }
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

printf "  ${YELLOW}1.${RESET} Create your wallet via the web UI:\n"
printf "     ${CYAN}${PASSKEY_ORIGIN}/setup${RESET}\n\n"

printf "  ${DIM}Other useful commands:${RESET}\n"
printf "  ${GRAY}${COMPOSE} logs -f wallet-rpc-daemon   # watch wallet daemon logs${RESET}\n"
printf "  ${GRAY}${COMPOSE} run --rm wallet-cli         # interactive CLI${RESET}\n"
printf "  ${GRAY}${COMPOSE} down                        # stop everything${RESET}\n"
printf "\n"
printf "  ${DIM}Note: mainnet sync takes hours on first run.${RESET}\n"
printf "  ${DIM}Balance and history appear once the node is fully synced.${RESET}\n"
if [[ "$ENABLE_BITCOIN" == "yes" ]]; then
  printf "\n"
  printf "  ${DIM}Bitcoin: the BTC node syncs independently (days on mainnet).${RESET}\n"
  printf "  ${DIM}Open the Bitcoin page in the web UI to create your BTC wallet${RESET}\n"
  printf "  ${DIM}and back up its seed phrase when prompted.${RESET}\n"
fi
if [[ "$WEB_GUI_TLS" == "true" ]]; then
  printf "\n"
  printf "  ${DIM}HTTPS: Caddy generates the local CA on first start (may take a few seconds).${RESET}\n"
  printf "  ${DIM}Open https://${WEB_GUI_HOST} once, accept the warning, then download the CA${RESET}\n"
  printf "  ${DIM}root from Settings -> HTTPS to silence it permanently on your devices.${RESET}\n"
  printf "  ${DIM}Passkeys are available automatically since you have a proper hostname.${RESET}\n"
fi
printf "\n"

# ── Open browser ──────────────────────────────────────────────────────────────
if [[ "$START" == "yes" ]]; then
  OPEN_URL="${PASSKEY_ORIGIN}/setup"

  # Give the web-gui container a moment to finish starting
  sleep 2

  # Open the browser (macOS: open, Linux: xdg-open, WSL: cmd.exe)
  if command -v open &>/dev/null; then
    open "$OPEN_URL"
  elif command -v xdg-open &>/dev/null; then
    xdg-open "$OPEN_URL"
  elif command -v cmd.exe &>/dev/null; then
    cmd.exe /c start "$OPEN_URL"
  else
    printf "  ${YELLOW}▲${RESET}  Could not detect a browser opener. Visit manually:\n"
    printf "     ${CYAN}${OPEN_URL}${RESET}\n\n"
  fi
fi
