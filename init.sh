#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd) || exit 1
CLEANUP_FILES=""   # .env heredoc tmp (registered when created); swept by the traps.
                   # Unquoted expansion in the traps is safe: the whitespace guard
                   # rejects checkouts with spaces in their path.
trap 'rm -f "$SCRIPT_DIR/.env.tmp.$$" ${CLEANUP_FILES:-} 2>/dev/null || true; chmod 700 "$SCRIPT_DIR/mintlayer-data/prefs" 2>/dev/null || true' EXIT
trap 'rm -f "$SCRIPT_DIR/.env.tmp.$$" ${CLEANUP_FILES:-} 2>/dev/null || true; chmod 700 "$SCRIPT_DIR/mintlayer-data/prefs" 2>/dev/null || true; exit 130' INT
trap 'rm -f "$SCRIPT_DIR/.env.tmp.$$" ${CLEANUP_FILES:-} 2>/dev/null || true; chmod 700 "$SCRIPT_DIR/mintlayer-data/prefs" 2>/dev/null || true; exit 143' TERM
trap 'rm -f "$SCRIPT_DIR/.env.tmp.$$" ${CLEANUP_FILES:-} 2>/dev/null || true; chmod 700 "$SCRIPT_DIR/mintlayer-data/prefs" 2>/dev/null || true; exit 129' HUP
# Sweep this run's .env temp copy (credentials mid-rewrite) on any exit.
# INT/TERM clean up and then exit - a bare cleanup trap would resume the
# script after Ctrl-C. $$ matches env_set's temp file name below.
# EXIT/INT/TERM also restore 0700 on the prefs dir: the credential-seeding
# step widens it to 0777 for a rootful container, and an interrupted run
# would otherwise leave a world-writable credentials directory behind.
# Log window for the Tailscale login-URL scrape: URLs printed before this
# run started may be consumed/expired from an earlier attempt.
SCRIPT_START_EPOCH=$(date +%s)
# Anchor to the checkout: every path below (.env, bind mounts, compose
# project dir) assumes repo-root CWD, so `bash /path/to/init.sh` from
# elsewhere would otherwise write .env into the wrong directory.
cd -- "$(dirname -- "${BASH_SOURCE[0]}")" || exit 1
# Best-effort sweep of residue from a SIGKILLed/aborted earlier run (the
# traps only cover this run's pid). Only files idle for over an hour are
# swept: a concurrent live run's temp is recent and must survive (its rename
# depends on it). Runs AFTER the anchor so it sweeps the checkout's
# directory, not the caller's.
find . -maxdepth 1 -name '.env.tmp.*' -mmin +60 -delete 2>/dev/null || true

# ─────────────────────────────────────────────────────────────────────────────
# Mintlayer Nexus - interactive setup
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
  local var="$1" question="$2" input
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
    # Bounded urandom read: an unbounded 'cat /dev/urandom | tr | head'
    # SIGPIPEs under 'set -o pipefail' (head exits early, the producer
    # dies mid-write, the script aborts). 512 bytes yield ~120 alnum
    # chars, far more than needed, and small enough to fit a pipe buffer.
    head -c 512 /dev/urandom | tr -dc 'a-zA-Z0-9' | head -c 32
  fi
}

# Real shell assignment (the .env heredoc below only writes the TEXT
# 'PROJECT_DIR_HOST=...'), needed by the whitespace guard early in the
# script and by the feature-enabler .env consumers.
PROJECT_DIR_HOST=$(pwd)
case "$PROJECT_DIR_HOST" in
  *[[:space:]]*)
    err "The repository path contains whitespace: $PROJECT_DIR_HOST"
    err "Settings-page feature toggles will not work."
    err "Move this checkout to a path without spaces and re-run init.sh."
    exit 1
    ;;
esac

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
  # Check Docker first - give OS-specific install instructions if missing
  if ! command -v docker &>/dev/null; then
    err "Docker is not installed or not in PATH."
    docker_install_hint
    exit 1
  fi

  # Docker found - make sure the daemon is actually running
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
  # env_set() needs fs.rmSync (>= 14.14) and the Tailscale status parser uses
  # optional chaining (>= 14): enforce the advertised floor, not just presence.
  node -e 'process.exit(parseInt(process.versions.node, 10) < 18 ? 1 : 0)' || {
    err "Node.js v18+ is required."
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

# ── Update a single KEY=VALUE line in .env ──────────────
env_set() {
  # env_set KEY VALUE - rewrite "KEY=" in .env, appending when absent.
  # Uses node (a checked prerequisite) instead of sed -i: BSD and GNU sed
  # disagree on how -i takes its backup argument. The temp file name comes
  # from bash's $$ so the EXIT trap sweeps crash residue. KEY/VALUE travel
  # via the environment, not argv: `ps` shows argv world-readable, and a
  # future call site passing a secret must not leak through the process
  # table (/proc/<pid>/environ is owner-only).
  OCR_ENV_SET_KEY="$1" OCR_ENV_SET_VALUE="$2" OCR_ENV_SET_TMP=".env.tmp.$$" \
    node -e '
    const fs = require("fs");
    const key = process.env.OCR_ENV_SET_KEY;
    const value = process.env.OCR_ENV_SET_VALUE;
    const tmp = process.env.OCR_ENV_SET_TMP;
    // Validate before touching .env: an embedded newline would corrupt every
    // line after the rewritten key.
    if (/[\r\n]/.test(key) || /[\r\n]/.test(value)) {
      console.error("env_set: key and value must not contain newlines");
      process.exit(1);
    }
    if (/\$/.test(key) || /\$/.test(value)) {
      console.error("env_set: key and value must not contain $ (compose would expand it)");
      process.exit(1);
    }
    let lines;
    try {
      lines = fs.readFileSync(".env", "utf8").replace(/\r\n/g, "\n").split("\n");
    } catch (err) {
      console.error("env_set: cannot read .env - run init.sh first: " + err.message);
      process.exit(1);
    }
    let found = false;
    const rewritten = lines.map((line) => {
      // Match indented (compose trims keys) and `export KEY=` lines too, so a
      // hand-edited .env is replaced in place instead of duplicated.
      const stripped = line.trim().replace(/^export\s+/, "");
      if (stripped.startsWith(key + "=")) {
        found = true;
        return key + "=" + value;
      }
      return line;
    });
    if (!found) rewritten.push(key + "=" + value);
    if (rewritten[rewritten.length - 1] !== "") rewritten.push("");
    // Atomic replace: an interrupted truncate-in-place write would destroy
    // the SESSION_SECRET/RPC/DB credentials in .env. mode 0600 applies at
    // creation (umask cannot widen it); rm clears pid-reuse staleness and
    // the EXIT trap (same bash $$ via the tmp env var) sweeps residue.
    // 'wx' = O_CREAT|O_EXCL: a racing local user could swap the predictable
    // .env.tmp.<pid> path for a symlink in the rm->write window - O_EXCL
    // refuses the path instead of following it, aborting the rewrite rather
    // than leaking credentials to an attacker-chosen target.
    fs.rmSync(tmp, { force: true });
    const fd = fs.openSync(tmp, "wx", 0o600);
    fs.writeFileSync(fd, rewritten.join("\n"));
    // fsync before rename: without it a power loss can persist the rename
    // while the temp file data blocks are still in page cache.
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmp, ".env");
  '
}

# lower STRING - lowercase without bash-4 ${var,,} (macOS ships bash 3.2).
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# password_reject_reason VALUE - print the rejection reason for a user-chosen
# password (empty = acceptable). Rejects $ because compose expands $VAR/
# ${VAR} in .env values, which would corrupt the credential on write.
password_reject_reason() {
  if [[ ${#1} -lt 8 ]]; then
    printf "Password must be at least 8 characters"
  elif [[ "$1" == *'$'* ]]; then
    printf 'Password must not contain $ - compose would expand it in .env'
  elif [[ "$1" == *' #'* ]]; then
    printf 'Password must not contain " #" - compose treats it as an inline comment'
  elif [[ "$1" == '"'* || "$1" == "'"* ]]; then
    printf 'Password must not start with a quote - compose strips it from .env'
  elif [[ "$1" =~ ^[[:space:]] || "$1" =~ [[:space:]]$ ]]; then
    printf "Password must not start or end with whitespace - compose trims it"
  fi
}

# api_port_reject_reason VALUE - conflict/validity message for the indexer
# REST API port (empty = acceptable). Called after the access mode is chosen,
# so the TLS-gateway reservation only applies in that mode.
api_port_reject_reason() {
  if ! [[ "$1" =~ ^[0-9]{1,5}$ ]] || (( 10#$1 < 1 || 10#$1 > 65535 )); then
    printf "Enter a valid port number (1-65535)"
  elif (( 10#$1 == 10#$WEB_GUI_PORT )); then
    printf "Port %s is taken by the web GUI - pick another" "$1"
  elif [[ "$WEB_GUI_TLS" == "true" && "$1" == "443" ]]; then
    printf "Port 443 is reserved for the HTTPS gateway - pick another"
  fi
}

# show_totp_qr - render the TOTP URI as a terminal QR, falling back to the
# plain URI: qrencode -t ANSIUTF8 needs qrencode >= 3.4, and an older build
# used to abort the whole script mid-setup instead of degrading.
show_totp_qr() {
  if command -v qrencode &>/dev/null && \
     echo "$TOTP_URI" | qrencode -t ANSIUTF8 2>/dev/null | sed "s/^/${CYAN}│${RESET}  /"; then
    return 0
  fi
  printf "${CYAN}│${RESET}  ${GRAY}%s${RESET}\n" "$TOTP_URI"
  printf "${CYAN}│${RESET}  ${DIM}(Install qrencode >= 3.4 for a scannable QR code in the terminal)${RESET}\n"
  return 0
}

# ─────────────────────────────────────────────────────────────────────────────
# Banner
# ─────────────────────────────────────────────────────────────────────────────
clear 2>/dev/null || true
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
printf "  ${BOLD}Web GUI Setup${RESET}  ${GRAY}- node + wallet-rpc-daemon + web interface${RESET}\n"
printf "\n"
printf "${GRAY}  This script writes your .env and starts the Docker stack.${RESET}\n"
printf "\n"

check_prereqs

# ─────────────────────────────────────────────────────────────────────────────
# Step 1 - Network
# ─────────────────────────────────────────────────────────────────────────────
step "Network"
hint "mainnet uses real ML tokens; testnet is for experimentation"
hint ""

NETWORK_CHOICE=""
choose NETWORK_CHOICE "Which network?" \
  "mainnet  - real funds" \
  "testnet  - for testing, no real value"

case "$NETWORK_CHOICE" in
  "mainnet  - real funds") NETWORK="mainnet" ;;
  *)                       NETWORK="testnet" ;;
esac

divider

# ─────────────────────────────────────────────────────────────────────────────
# Step 2 - Passwords
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
  hint "Used by node-daemon - not exposed outside Docker"
  prompt_secret NODE_RPC_PASSWORD "Password:"
  reason="$(password_reject_reason "$NODE_RPC_PASSWORD")"
  while [[ -n "$reason" ]]; do
    printf "${CYAN}│${RESET}  ${RED}%s${RESET}\n" "$reason"
    prompt_secret NODE_RPC_PASSWORD "Password:"
    reason="$(password_reject_reason "$NODE_RPC_PASSWORD")"
  done

  ask "Wallet RPC password"
  hint "Used by wallet-rpc-daemon - not exposed outside Docker"
  prompt_secret WALLET_RPC_PASSWORD "Password:"
  reason="$(password_reject_reason "$WALLET_RPC_PASSWORD")"
  while [[ -n "$reason" ]]; do
    printf "${CYAN}│${RESET}  ${RED}%s${RESET}\n" "$reason"
    prompt_secret WALLET_RPC_PASSWORD "Password:"
    reason="$(password_reject_reason "$WALLET_RPC_PASSWORD")"
  done
fi

NODE_RPC_USERNAME="node_user"
WALLET_RPC_USERNAME="wallet_user"

divider

# ─────────────────────────────────────────────────────────────────────────────
# Step 3 - Web UI access (password + TOTP 2FA)
# ─────────────────────────────────────────────────────────────────────────────
step "Web UI access"
hint "Protect the wallet interface with a password and authenticator app (TOTP 2FA)."
hint ""

ask "Web UI password"
hint "Used to sign in to the wallet web interface."
hint "Choose a strong password - this guards access to your wallet."
UI_PASSWORD=""
UI_PASSWORD_CONFIRM=""
prompt_secret UI_PASSWORD "Password:"
reason="$(password_reject_reason "$UI_PASSWORD")"
while [[ -n "$reason" ]]; do
  printf "${CYAN}│${RESET}  ${RED}%s${RESET}\n" "$reason"
  prompt_secret UI_PASSWORD "Password:"
  reason="$(password_reject_reason "$UI_PASSWORD")"
done
prompt_secret UI_PASSWORD_CONFIRM "Confirm password:"
while [[ "$UI_PASSWORD" != "$UI_PASSWORD_CONFIRM" ]]; do
  printf "${CYAN}│${RESET}  ${RED}Passwords do not match, try again${RESET}\n"
  prompt_secret UI_PASSWORD "Password:"
  reason="$(password_reject_reason "$UI_PASSWORD")"
  while [[ -n "$reason" ]]; do
    printf "${CYAN}│${RESET}  ${RED}%s${RESET}\n" "$reason"
    prompt_secret UI_PASSWORD "Password:"
    reason="$(password_reject_reason "$UI_PASSWORD")"
  done
  prompt_secret UI_PASSWORD_CONFIRM "Confirm password:"
done

printf "${CYAN}│${RESET}\n"
hint "Hashing password (this may take a moment)..."
# Password is passed via env, not argv - keeps it out of the host process list.
UI_PASSWORD_HASH=$(UI_PASSWORD="$UI_PASSWORD" node -e "
  const c = require('crypto');
  const salt = c.randomBytes(32).toString('hex');
  c.pbkdf2(process.env.UI_PASSWORD, salt, 210000, 64, 'sha512', (err, key) => {
    if (err) { process.stderr.write(err.message + '\n'); process.exit(1); }
    process.stdout.write('pbkdf2:sha512:210000:' + salt + ':' + key.toString('hex'));
  });
")
[[ -n "$UI_PASSWORD_HASH" ]] || { err "Password hashing produced no output"; exit 1; }
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

# Generate session signing secret (urandom fallback: openssl can be
# absent on minimal hosts and this runs after every question was answered)
SESSION_SECRET=$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')

# Construct the otpauth URI
TOTP_URI="otpauth://totp/Mintlayer%20Nexus?secret=${UI_TOTP_SECRET}&issuer=Mintlayer"

printf "${CYAN}│${RESET}\n"
[[ -n "$UI_TOTP_SECRET" ]] || { err "TOTP secret generation failed"; exit 1; }
ok "TOTP secret generated"
printf "${CYAN}│${RESET}\n"
printf "${CYAN}│${RESET}  ${BOLD}Scan this with Google Authenticator, Authy, or any TOTP app:${RESET}\n"
printf "${CYAN}│${RESET}\n"

# Show QR code if qrencode is available, otherwise show the URI
show_totp_qr

printf "${CYAN}│${RESET}\n"
hint "Or enter the secret manually: ${BOLD}${UI_TOTP_SECRET}${RESET}"
printf "${CYAN}│${RESET}\n"
warn "Scan this QR code NOW before continuing - it will not be shown again."
printf "${CYAN}│${RESET}\n"
SCANNED="no"
confirm SCANNED "I have scanned the QR code / saved the TOTP secret" "N"
while [[ "$SCANNED" != "yes" ]]; do
  printf "${CYAN}│${RESET}  ${RED}Please scan the QR code or save the secret before continuing.${RESET}\n"
  printf "${CYAN}│${RESET}\n"
  # Re-display the URI in case they need it again
  show_totp_qr
  printf "${CYAN}│${RESET}\n"
  confirm SCANNED "I have scanned the QR code / saved the TOTP secret" "N"
done
ok "2FA configured"

divider

# ─────────────────────────────────────────────────────────────────────────────
# Step 4 - Web GUI port
# ─────────────────────────────────────────────────────────────────────────────
step "Web interface"

ask "Port for the web GUI"
hint "The Astro web interface will be available at http://localhost:<port>"
prompt WEB_GUI_PORT "Port:" "4321"

# Validate it's a number
while ! [[ "$WEB_GUI_PORT" =~ ^[0-9]{1,5}$ ]] || (( 10#$WEB_GUI_PORT < 1 || 10#$WEB_GUI_PORT > 65535 )); do
  printf "${CYAN}│${RESET}  ${RED}Enter a valid port number (1-65535)${RESET}\n"
  prompt WEB_GUI_PORT "Port:" "4321"
done
# The TLS gateway (mode chosen below) publishes host port 443 - a GUI port
# of 443 would collide only after the mode is picked, so reserve it now.
if (( 10#$WEB_GUI_PORT == 443 )); then
  warn "Port 443 is reserved for the HTTPS gateway - using 4321 for the GUI."
  WEB_GUI_PORT="4321"
fi

ask "Expose the web GUI to your network?"

# The Tailscale sidecar runs kernel-mode networking and needs a TUN device
# (Docker Desktop's VM provides one; native Linux almost always does).
# Unprivileged LXC, rootless Docker and some NAS setups don't - offering the
# option there would only crash-loop the sidecar.
TAILSCALE_AVAILABLE="true"
if [[ "$(detect_os)" == "linux" && ! -e /dev/net/tun ]]; then
  TAILSCALE_AVAILABLE="false"
fi

hint "Access modes:"
hint "  localhost only - the GUI is reachable solely from this machine;"
hint "    open it through an SSH tunnel. Most secure."
hint "  LAN over HTTPS - other devices open it at https://<hostname>; Caddy"
hint "    terminates TLS with a local Certificate Authority (works without a"
hint "    public domain). Browsers warn once until you import the CA root,"
hint "    downloadable from Settings -> HTTPS after setup."
hint "  Tailnet (Tailscale) - the GUI joins your tailnet; any device logged"
hint "    into it opens https://<name>.<tailnet>.ts.net with valid HTTPS."
hint "    Nothing is published to the LAN or the internet. Needs a (free)"
hint "    Tailscale account with MagicDNS + HTTPS certificates enabled."
hint "  LAN plain HTTP - not recommended: traffic is unencrypted and the"
hint "    session cookie is refused on non-localhost origins, so sign-in only"
hint "    works from this machine anyway."
if [[ "$TAILSCALE_AVAILABLE" != "true" ]]; then
  hint "Tailnet (Tailscale) is unavailable on this host: /dev/net/tun is"
  hint "  missing, so the sidecar cannot start."
fi
hint "Running your own TLS proxy on a public domain? Pick 'localhost only'"
hint "and set WEB_GUI_HOST + PASSKEY_* in .env manually (see .env.example)."

ACCESS_MODE_OPTIONS=("localhost only (SSH tunnel)" "LAN over HTTPS (Caddy local CA)")
if [[ "$TAILSCALE_AVAILABLE" == "true" ]]; then
  ACCESS_MODE_OPTIONS+=("Tailnet (Tailscale - remote access)")
fi
ACCESS_MODE_OPTIONS+=("LAN plain HTTP (not recommended)")

ACCESS_CHOICE=""
choose ACCESS_CHOICE "Access mode:" "${ACCESS_MODE_OPTIONS[@]}"

WEB_GUI_TLS="false"
WEB_GUI_BIND="127.0.0.1"
WEB_GUI_HOST="localhost"
TRUST_PROXY=""
TAILSCALE_ENABLED="false"
TAILSCALE_HOSTNAME="nexus"
TS_AUTHKEY=""
TS_EXTRA_ARGS=""
case "$ACCESS_CHOICE" in
  *"LAN over HTTPS"*)
    WEB_GUI_TLS="true"
    TRUST_PROXY="true"
    ask "Hostname for the HTTPS certificate"
    hint "Must resolve to this machine from your devices, e.g. ml1.local"
    hint "(mDNS) or an entry in your router's DNS / your device's hosts file."
    prompt WEB_GUI_HOST "Hostname:" "$(hostname -s 2>/dev/null || echo mintlayer-gui).local"
    # Hostname flows into the Caddyfile (pre-parse textual substitution),
    # docker-compose env interpolation, and the WebAuthn RP ID - so it must
    # be a plain lowercase DNS name. Uppercase is normalized; everything
    # else invalid is re-asked. (lower(), not ${var,,}: macOS ships bash 3.2.)
    WEB_GUI_HOST="$(lower "$WEB_GUI_HOST")"
    while ! [[ "$WEB_GUI_HOST" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$ ]]; do
      printf "${CYAN}│${RESET}  ${RED}Enter a valid hostname (letters, digits, dots, hyphens - uppercase is lowercased automatically; no ports, spaces or underscores)${RESET}\n"
      prompt WEB_GUI_HOST "Hostname:" "$(hostname -s 2>/dev/null || echo mintlayer-gui).local"
      WEB_GUI_HOST="$(lower "$WEB_GUI_HOST")"
    done
    warn "The GUI stays bound to 127.0.0.1 - only the HTTPS gateway (port 443) is exposed."
    hint "Always open https://${WEB_GUI_HOST} - plain http:// (port 80) is not published."
    ;;
  *"Tailnet (Tailscale"*)
    TAILSCALE_ENABLED="true"
    # Traffic arrives through the shipped sidecar, which overwrites
    # X-Forwarded-For - the same trust model as the caddy gateway.
    TRUST_PROXY="true"
    ask "Tailscale node name"
    hint "Devices on your tailnet will open https://<name>.<tailnet>.ts.net."
    prompt TAILSCALE_HOSTNAME "Name:" "nexus"
    # Flows into the sidecar hostname, the ts.net certificate name and
    # MagicDNS - a plain lowercase DNS label only.
    TAILSCALE_HOSTNAME="$(lower "$TAILSCALE_HOSTNAME")"
    while ! [[ "$TAILSCALE_HOSTNAME" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]]; do
      printf "${CYAN}│${RESET}  ${RED}Enter a short DNS name (letters, digits, hyphens - uppercase is lowercased automatically)${RESET}\n"
      prompt TAILSCALE_HOSTNAME "Name:" "nexus"
      TAILSCALE_HOSTNAME="$(lower "$TAILSCALE_HOSTNAME")"
    done

    printf "${CYAN}│${RESET}\n"
    TS_AUTH_CHOICE=""
    choose TS_AUTH_CHOICE "How should the node join your tailnet?" \
      "Login URL - approve once in the browser, nothing secret is stored" \
      "Auth key - paste a key from the Tailscale admin console (headless)"
    TS_AUTHKEY=""
    if [[ "$TS_AUTH_CHOICE" == *"Auth key"* ]]; then
      ask "Tailscale auth key"
      hint "Admin console -> Settings -> Keys. The key lands in .env"
      hint "(chmod 600, gitignored). Leave blank to use the login URL instead."
      prompt_secret TS_AUTHKEY "Auth key:"
      # Paste hygiene: strip surrounding whitespace (trailing spaces, CR from Windows clips).
      TS_AUTHKEY="$(printf '%s' "$TS_AUTHKEY" | tr -d '[:space:]')"
      # Only plain tskey-auth-... tokens: the value lands unquoted in .env,
      # where compose expands $VAR/${VAR} references in values - a malformed
      # paste would corrupt interpolation or leak other secrets from this
      # file into the sidecar environment.
      if [[ -n "$TS_AUTHKEY" && ! "$TS_AUTHKEY" =~ ^tskey-auth-[A-Za-z0-9_-]+$ ]]; then
        warn "That does not look like a Tailscale auth key (expected tskey-auth-...)."
        hint "Falling back to the interactive login-URL flow."
        TS_AUTHKEY=""
      fi
    fi

    warn "The GUI stays bound to 127.0.0.1 on the host - only the Tailscale"
    warn "sidecar reaches the stack, and only from inside your tailnet."
    hint "Note: some hosts (unprivileged LXC, rootless Docker) accept the"
    hint "/dev/net/tun device but deny its configuration - the sidecar then"
    hint "restart-loops. If that happens: docker compose logs tailscale, and"
    hint "re-run ./init.sh to pick a different access mode."
    ;;
  *"LAN plain HTTP"*)
    WEB_GUI_BIND="0.0.0.0"
    warn "GUI will be reachable from other machines (plain HTTP)."
    warn "Login requires a Secure session cookie, which browsers refuse on"
    warn "plain HTTP for non-localhost origins - sign-in works only locally."
    ;;
  *)
    ;;
esac

# Passkeys (WebAuthn) need a proper DNS hostname - they never work from raw
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
# Step 5 - Indexer
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

API_WEB_SERVER_PORT="3000"
if [[ "$ENABLE_INDEXER" == "yes" ]]; then
  if [[ "$USE_RANDOM_PASSWORDS" == "yes" ]]; then
    POSTGRES_PASSWORD=$(rand_pass)
    ok "Generated random PostgreSQL password (saved to .env)"
  else
    ask "PostgreSQL password"
    prompt_secret POSTGRES_PASSWORD "Password:"
    reason="$(password_reject_reason "$POSTGRES_PASSWORD")"
    while [[ -n "$reason" ]]; do
      printf "${CYAN}│${RESET}  ${RED}%s${RESET}\n" "$reason"
      prompt_secret POSTGRES_PASSWORD "Password:"
      reason="$(password_reject_reason "$POSTGRES_PASSWORD")"
    done
  fi

  ask "Port for the blockchain REST API"
  prompt API_WEB_SERVER_PORT "Port:" "3000"
  # Same validation as the web GUI port: garbage here breaks the compose
  # port mapping (127.0.0.1:${API_WEB_SERVER_PORT:-3000}:3000).
  reason="$(api_port_reject_reason "$API_WEB_SERVER_PORT")"
  while [[ -n "$reason" ]]; do
    printf "${CYAN}│${RESET}  ${RED}%s${RESET}\n" "$reason"
    prompt API_WEB_SERVER_PORT "Port:" "3000"
    reason="$(api_port_reject_reason "$API_WEB_SERVER_PORT")"
  done
else
  # Inert while the indexer profile is off, but pre-filled so a later manual
  # `docker compose --profile indexer up -d` works instead of crash-looping
  # postgres (it refuses an empty superuser password). Parity with the
  # deploy flavors.
  POSTGRES_PASSWORD=$(rand_pass)
fi

divider

# ─────────────────────────────────────────────────────────────────────────────
# Step - Bitcoin node + BTC wallet (optional)
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
# Random per-install username: a fixed one confirms the username to anyone
# probing the wallet API endpoint.
BITCOIN_WALLET_HTTP_USERNAME="btcwallet_$(rand_pass | head -c 8)"
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
    reason="$(password_reject_reason "$BITCOIN_RPC_PASSWORD")"
    while [[ -n "$reason" ]]; do
      printf "${CYAN}│${RESET}  ${RED}%s${RESET}\n" "$reason"
      prompt_secret BITCOIN_RPC_PASSWORD "Password:"
      reason="$(password_reject_reason "$BITCOIN_RPC_PASSWORD")"
    done
    ask "BTC wallet API password"
    prompt_secret BITCOIN_WALLET_HTTP_PASSWORD "Password:"
    reason="$(password_reject_reason "$BITCOIN_WALLET_HTTP_PASSWORD")"
    while [[ -n "$reason" ]]; do
      printf "${CYAN}│${RESET}  ${RED}%s${RESET}\n" "$reason"
      prompt_secret BITCOIN_WALLET_HTTP_PASSWORD "Password:"
      reason="$(password_reject_reason "$BITCOIN_WALLET_HTTP_PASSWORD")"
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
# Step - Auto-update (Watchtower)
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
  # The value lands unquoted in .env: compose expands $VAR/${VAR} in values,
  # which would corrupt the URL or pull other secrets from this file.
  if [[ "$WATCHTOWER_NOTIFICATION_URL" == *'$'* ]]; then
    err "Notification URL must not contain \$ - compose would expand it."
    exit 1
  fi
fi

divider

# ─────────────────────────────────────────────────────────────────────────────
# Step - IPFS Storage (optional)
# ─────────────────────────────────────────────────────────────────────────────
step "IPFS Storage (optional)"
hint "Enables automatic upload of token/NFT images and metadata to IPFS."
hint "Without this, URLs can still be entered manually - you can configure this"
hint "later in the web UI Settings page."
hint ""

SETUP_IPFS="no"
confirm SETUP_IPFS "Configure IPFS now?" "N"

IPFS_PROVIDER=""
FILEBASE_TOKEN=""
PINATA_JWT=""

if [[ "$SETUP_IPFS" == "yes" ]]; then
  hint "  Filebase - 5 GB free, always public - https://filebase.com"
  hint "  Pinata   - requires paid plan for public files - https://app.pinata.cloud"
  hint ""

  IPFS_CHOICE=""
  choose IPFS_CHOICE "Choose IPFS provider:" \
    "Filebase (recommended - 5 GB free, always public)" \
    "Pinata (paid account required to make files public)"

  case "$IPFS_CHOICE" in
    *"Filebase"*)
      IPFS_PROVIDER="filebase"
      ask "Filebase API key"
      hint "Find it at https://console.filebase.com/keys - scroll to the bottom"
      hint "for the bucket-specific IPFS API keys (not the S3 access keys at the top)."
      prompt_secret FILEBASE_TOKEN "API key:"
      while [[ -z "$FILEBASE_TOKEN" ]]; do
        printf "${CYAN}│${RESET}  ${RED}API key cannot be empty${RESET}\n"
        prompt_secret FILEBASE_TOKEN "API key:"
      done
      # The token lands unquoted in .env: compose expands $VAR/${VAR} there,
      # which would corrupt the key or pull other secrets from this file.
      if [[ "$FILEBASE_TOKEN" == *'$'* ]]; then
        err "Filebase API key must not contain \$ - compose would expand it."
        exit 1
      fi
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
      # Same .env interpolation hazard: reject $ early.
      if [[ "$PINATA_JWT" == *'$'* ]]; then
        err "Pinata JWT must not contain \$ - compose would expand it."
        exit 1
      fi
      ok "Pinata JWT saved"
      ;;
  esac
fi

divider

# ─────────────────────────────────────────────────────────────────────────────
# Step - Telegram Notifications (optional)
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
  # Same .env interpolation hazard as above: reject $ early.
  if [[ "$TELEGRAM_BOT_TOKEN" == *'$'* || "$TELEGRAM_CHAT_ID" == *'$'* ]]; then
    err "Telegram token and chat ID must not contain \$ - compose would expand them."
    exit 1
  fi
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
[[ "$TAILSCALE_ENABLED" == "true" ]] && printf "${CYAN}│${RESET}  %-22s %s\n" "Remote access:" "${BOLD}Tailscale tailnet (${TAILSCALE_HOSTNAME}.<tailnet>.ts.net)${RESET}"
printf "${CYAN}│${RESET}  %-22s %s\n" "Passkeys:"   "${BOLD}$([ "$WEB_GUI_HOST" != "localhost" ] && echo "enabled (${WEB_GUI_HOST})" || echo "localhost only")${RESET}"
printf "${CYAN}│${RESET}  %-22s %s\n" "Indexer:"      "${BOLD}$([ "$ENABLE_INDEXER" == "yes" ] && echo "enabled (port ${API_WEB_SERVER_PORT}) - Token Management + Trading active" || echo "disabled - Token Management + Trading hidden")${RESET}"
printf "${CYAN}│${RESET}  %-22s %s\n" "Bitcoin:"     "${BOLD}$([ "$ENABLE_BITCOIN" == "yes" ] && echo "enabled (node + BTC wallet)" || echo "disabled")${RESET}"
printf "${CYAN}│${RESET}  %-22s %s\n" "IPFS storage:" "${BOLD}$([ -n "$IPFS_PROVIDER" ] && echo "$IPFS_PROVIDER" || echo "disabled - configure later in Settings")${RESET}"
printf "${CYAN}│${RESET}  %-22s %s\n" "Telegram:"     "${BOLD}$([ -n "$TELEGRAM_BOT_TOKEN" ] && echo "configured" || echo "disabled - configure later in Settings")${RESET}"
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
# Use 1000 in that case - it's the standard unprivileged GID on Linux.
# The same floor applies to the UID: a sudo-run installer would otherwise
# map the container's mintlayer user to uid 0 (root).
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

# Derive boolean flags
INDEXER_ENABLED=$([ "$ENABLE_INDEXER" == "yes" ] && echo "true" || echo "false")
BITCOIN_ENABLED=$([ "$ENABLE_BITCOIN" == "yes" ] && echo "true" || echo "false")

# ── Image tag selection ──────────────────────────────────────────────────────
# Compose defaults to :latest, which CI publishes only from main. On a
# feature branch, pin the CI-built branch tags instead (docker.yml publishes
# :br-<branch-slug>); outside a git checkout, fall back to latest.
IMAGE_TAG="latest"
if BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" && [[ -n "$BRANCH" && "$BRANCH" != "HEAD" && "$BRANCH" != "main" ]]; then
  IMAGE_TAG="br-${BRANCH//\//-}"
  ok "Pinning prebuilt images to branch tag: $IMAGE_TAG"
fi
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
# An empty BITCOIN_NETWORK follows the Mintlayer network - including on
# testnet installs (the old hardcoded "main" default provisioned a mainnet
# Bitcoin node alongside a testnet Mintlayer node).
if [[ -z "$BITCOIN_NETWORK" ]]; then
  BITCOIN_NETWORK="$NETWORK"
fi
BITCOIN_CORE_CHAIN="$BITCOIN_NETWORK"
# Core's -chain wants "main"/"test"/"regtest"/"signet": map the Mintlayer
# names that differ ("mainnet" -> "main", "testnet" -> "test").
if [[ "$BITCOIN_CORE_CHAIN" == "mainnet" ]]; then
  BITCOIN_CORE_CHAIN="main"
elif [[ "$BITCOIN_CORE_CHAIN" == "testnet" ]]; then
  BITCOIN_CORE_CHAIN="test"
fi

# Compose profiles matching the user's choices (mirrored into .env below so
# later 'make up' runs keep the same services).
COMPOSE_PROFILES_LINE=""
[[ "$ENABLE_INDEXER" == "yes" ]] && COMPOSE_PROFILES_LINE="indexer"
[[ "$ENABLE_BITCOIN" == "yes" ]] && COMPOSE_PROFILES_LINE="${COMPOSE_PROFILES_LINE:+$COMPOSE_PROFILES_LINE,}bitcoin"
[[ "$ENABLE_WATCHTOWER" == "yes" ]] && COMPOSE_PROFILES_LINE="${COMPOSE_PROFILES_LINE:+$COMPOSE_PROFILES_LINE,}watchtower"
[[ "$WEB_GUI_TLS" == "true" ]] && COMPOSE_PROFILES_LINE="${COMPOSE_PROFILES_LINE:+$COMPOSE_PROFILES_LINE,}web"
[[ "$TAILSCALE_ENABLED" == "true" ]] && COMPOSE_PROFILES_LINE="${COMPOSE_PROFILES_LINE:+$COMPOSE_PROFILES_LINE,}tailscale"

# Build the full wallet-rpc-daemon command (avoids shell expansion tricks in docker-compose)
WALLET_RPC_CMD="wallet-rpc-daemon ${NETWORK}"

# .env holds SESSION_SECRET + RPC passwords: create it group/world-readonly
# from the start (umask 077), and harden any pre-existing file too.
if [[ -f .env ]]; then
  ENV_BACKUP=".env.bak.$(date +%Y%m%d-%H%M%S)"
  # install -m 600: mode applied at creation (no world-readable window), and
  # a failed backup aborts the run BEFORE the destructive .env rewrite below
  # (a bare `cp && chmod` would swallow the failure inside the && list).
  install -m 600 .env "$ENV_BACKUP"
  # Keep the 3 most recent backups; each holds a complete old credential set.
  # Also tighten modes of retained backups created before install -m 600.
  chmod 600 .env.bak.* 2>/dev/null || true
  { ls -1t .env.bak.* 2>/dev/null || true; } | tail -n +4 | while IFS= read -r old; do
    rm -f "$old"
  done
  warn "Existing .env detected - old credentials saved to $ENV_BACKUP."
  warn "Re-running setup REGENERATES the password, 2FA secret and RPC credentials; you will be logged out and must re-scan TOTP."
fi
# mktemp = O_EXCL: the predictable .env.tmp.$$ redirect follows a racing
# symlink; a random name refuses it. Registered for trap cleanup below.
ENV_TMP="$(mktemp .env.tmp.XXXXXX)" || {
  err "Could not create a temporary file in this directory (disk full, permissions?)."
  hint "Free up space or fix permissions, then re-run ./init.sh."
  exit 1
}
CLEANUP_FILES+=" $ENV_TMP"
( umask 077 && cat > "$ENV_TMP" <<EOF
# Generated by init.sh on $(date)
# ─────────────────────────────────────────

# Network: mainnet | testnet
NETWORK=${NETWORK}

# Docker user/group IDs
ML_USER_ID=${ML_USER_ID}
ML_GROUP_ID=${ML_GROUP_ID}

# wallet-rpc-daemon command (network only - wallet files are managed via the web UI)
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

# Proxy-derived headers (client IP + Origin): true only when traffic arrives
# through a shipped proxy - the caddy gateway (above) or the Tailscale
# sidecar (below). Direct/LAN exposure must keep this empty.
TRUST_PROXY=${TRUST_PROXY}

# Remote access via Tailscale (profile: tailscale)
# Node name in your tailnet; the GUI is served at https://<name>.<tailnet>.ts.net
TAILSCALE_HOSTNAME=${TAILSCALE_HOSTNAME}
# tskey-auth-... joins headlessly; empty = interactive login URL printed in
# the sidecar logs on first start (docker compose logs -f tailscale)
TS_AUTHKEY=${TS_AUTHKEY}
# Optional 'tailscale up' extras, e.g. --advertise-tags=tag:nexus
# NOTE: compose expands \$VAR/\${VAR} inside .env values - escape a literal
# '\$' as '\$\$', or the sidecar environment gets interpolated/corrupted.
TS_EXTRA_ARGS=${TS_EXTRA_ARGS}

# Passkeys (WebAuthn) - derived from WEB_GUI_HOST above
# Override these if running behind a reverse proxy that changes the visible hostname.
PASSKEY_RP_ID=${PASSKEY_RP_ID}
PASSKEY_ORIGIN=${PASSKEY_ORIGIN}

# Indexer-dependent features (Token Management, Trading)
INDEXER_ENABLED=${INDEXER_ENABLED}

# Session signing secret (generated by init.sh)
SESSION_SECRET=${SESSION_SECRET}

# Watchtower - auto-update Mintlayer images (profile: watchtower)
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

# Prebuilt image refs (branch deploys pin CI-built tags; :latest = main only)
ML_NODE_DAEMON_IMAGE=ghcr.io/mintlayer/web-gui/node-daemon:${IMAGE_TAG}
ML_WALLET_RPC_DAEMON_IMAGE=ghcr.io/mintlayer/web-gui/wallet-rpc-daemon:${IMAGE_TAG}
WEB_GUI_IMAGE=ghcr.io/mintlayer/web-gui/web-gui:${IMAGE_TAG}
BDK_WALLET_IMAGE=ghcr.io/mintlayer/web-gui/bdk-wallet:${IMAGE_TAG}
BTC_EXPLORER_IMAGE=ghcr.io/mintlayer/web-gui/btc-explorer:${IMAGE_TAG}
ML_API_SCANNER_IMAGE=ghcr.io/mintlayer/web-gui/api-blockchain-scanner-daemon:${IMAGE_TAG}
ML_API_WEB_SERVER_IMAGE=ghcr.io/mintlayer/web-gui/api-web-server:${IMAGE_TAG}

# Persist the chosen optional-service profiles so later 'make up'/'docker
# compose up' runs start the same set as the installer did (without this,
# the indexer/bitcoin/watchtower/web services silently vanish on the next run).
COMPOSE_PROFILES=${COMPOSE_PROFILES_LINE}

# Absolute path of this install directory. The feature-enabler sidecar mounts
# the project at the SAME path inside its container and passes it to
# 'docker compose --project-directory' - identical paths keep the compose
# project name and every relative bind mount resolving to this directory on
# the host (a mismatched path would build a phantom duplicate stack).
PROJECT_DIR_HOST=${PROJECT_DIR_HOST}
EOF
mv -f "$ENV_TMP" .env
)
chmod 600 .env 2>/dev/null || true

ok ".env written"

# ── Write credentials to SQLite via temporary alpine container ───────────────
# uploads/ is bind-mounted into web-gui; pre-create it here so it is owned by
# this user (docker creates missing bind-mount dirs as root).
mkdir -p mintlayer-data/prefs mintlayer-data/plugins mintlayer-data/uploads
# Rootless docker maps the container uid to an unrelated host uid, so the
# seeding container needs write access to this bind mount. 0777 applies to
# the seeding window only - the alpine container tightens it to 0700 (and
# chowns the DB to this user) a few lines down; do not 'fix' this to 0770,
# rootless hosts have no shared group to grant it to.
# Note on the 1777 window: a local user could pre-plant mintlayer_prefs.sqlite
# for the seeding container to follow. The container writes to an unpredictable
# mktemp name instead and atomically renames over any pre-planted entry
# (rename does not follow symlinks), the EXIT/INT/TERM/HUP traps restore 0700,
# and a pre-planted target fails seeding loudly instead of writing silently.
chmod 1777 mintlayer-data/prefs
# sql_json VALUE -> stdout: VALUE as a JSON string literal, safe inside a
# single-quoted SQL literal. The app JSON.parse()s every pref value, so the
# DB must hold '"value"' - quotes included - or login breaks on a fresh
# install. Order matters: backslashes first, then double quotes (both for
# JSON), then single quotes (doubled for SQL).
sql_json() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e "s/'/''/g"
}

SEED_OK="true"
SEED_RC=0
# pref_sql KEY VALUE -> a complete INSERT statement storing VALUE as a
# JSON string (quotes included) - getPref() JSON.parses every row.
pref_sql() {
  printf "INSERT OR REPLACE INTO prefs VALUES ('%s', '\"%s\"');\n" "$1" "$(sql_json "$2")"
}
{
  echo "CREATE TABLE IF NOT EXISTS prefs (key TEXT PRIMARY KEY, value TEXT NOT NULL);"
  pref_sql 'auth.password_hash' "${UI_PASSWORD_HASH}"
  pref_sql 'auth.totp_secret'   "${UI_TOTP_SECRET}"
  [ -n "$IPFS_PROVIDER"      ] && pref_sql 'ipfs.provider'       "${IPFS_PROVIDER}" || true
  [ -n "$FILEBASE_TOKEN"     ] && pref_sql 'ipfs.filebase_token' "${FILEBASE_TOKEN}" || true
  [ -n "$PINATA_JWT"         ] && pref_sql 'ipfs.pinata_jwt'     "${PINATA_JWT}" || true
  [ -n "$TELEGRAM_BOT_TOKEN" ] && pref_sql 'telegram.bot_token'  "${TELEGRAM_BOT_TOKEN}" || true
  [ -n "$TELEGRAM_CHAT_ID"   ] && pref_sql 'telegram.chat_id'    "${TELEGRAM_CHAT_ID}" || true
} | docker run --rm -i \
    -v "$(pwd)/mintlayer-data/prefs:/prefs" \
    alpine \
    sh -c 'apk add -q --no-progress sqlite >/dev/null 2>&1 || exit 1
      [ -e /prefs/mintlayer_prefs.sqlite ] && { echo "refusing pre-planted target" >&2; exit 3; }
      db=$(mktemp /prefs/db.XXXXXX) || exit 1
      # Sweep the credential-bearing temp on any outcome: after a successful mv
      # this is a no-op, on failure it removes the residue.
      trap "rm -f \$db" EXIT
      sqlite3 "$db" && chmod 600 "$db" && mv -f "$db" /prefs/mintlayer_prefs.sqlite || exit 1
      chmod 700 /prefs || true
      exit 0' \
    || { SEED_RC=$?; SEED_OK="false"; }
if [[ "$SEED_OK" != "true" ]]; then
  # Close the 1777 seeding window the host-side chmod opened earlier.
  chmod 700 mintlayer-data/prefs 2>/dev/null || true
  if [[ "${SEED_RC:-0}" == "3" ]]; then
    err "Refusing a pre-planted mintlayer_prefs.sqlite in the prefs directory."
    hint "Remove that file and re-run ./init.sh."
  else
    err "Credential seeding failed (this step needs network: 'apk add sqlite')."
    hint ".env holds the new credentials; the prefs DB was NOT updated."
    hint "Re-run ./init.sh once the network is available - it regenerates the"
    hint "credentials and reseeds (you will need to re-scan the TOTP QR code)."
  fi
  exit 1
fi
# The seeding container runs as root; tighten ownership of the prefs DB to the
# invoking user so the app (and only it) can read the TOTP secret/hash.
if ! docker run --rm -v "$(pwd)/mintlayer-data/prefs:/prefs" alpine \
    chown -R "${ML_USER_ID}:${ML_GROUP_ID}" /prefs >/dev/null 2>&1; then
  warn "Could not hand the credentials DB to uid ${ML_USER_ID}:${ML_GROUP_ID}."
  hint "If the web GUI cannot read its credentials, run:"
  hint "  sudo chown -R ${ML_USER_ID}:${ML_GROUP_ID} mintlayer-data/prefs"
fi
# Seeding is done: close the 1777 window immediately instead of leaving it
# open for the rest of the script (the EXIT trap would only catch it at exit).
chmod 700 mintlayer-data/prefs 2>/dev/null || true
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
  if [[ "$TAILSCALE_ENABLED" == "true" ]]; then
    PROFILES="$PROFILES --profile tailscale"
  fi

  # Pull the CI-built multi-arch images (amd64+arm64) from ghcr.io and start.
  # Local rebuilds stay available: docker compose build (see README).
  $COMPOSE $PROFILES pull --quiet || {
    hint "Prebuilt image pull failed. On a fresh branch, CI must have published"
    hint "ghcr.io/mintlayer/web-gui/*:${IMAGE_TAG} first - falling back to a local build."
    $COMPOSE $PROFILES build
  }
  $COMPOSE $PROFILES up -d

  ok "Services started"

  # ── Tailscale: join the tailnet, capture the ts.net name, wire passkeys ──
  # The ts.net FQDN only exists after the node joins, so the WEB_GUI_HOST /
  # PASSKEY_* placeholders written to .env above get their real values here.
  if [[ "$TAILSCALE_ENABLED" == "true" ]]; then
    printf "${CYAN}│${RESET}\n"
    hint "Waiting for the Tailscale sidecar to join your tailnet..."

    # ts_status - one line per call: "<BackendState> <fqdn>" (fqdn empty
    # unless Running with MagicDNS). "Unknown" state when the sidecar is down.
    ts_status() {
      $COMPOSE exec -T tailscale tailscale status --json 2>/dev/null | node -e '
        let raw = "";
        process.stdin.on("data", (chunk) => { raw += chunk; });
        process.stdin.on("end", () => {
          try {
            const s = JSON.parse(raw);
            const dns = s.BackendState === "Running" ? (s.Self?.DNSName || "").replace(/\.$/, "") : "";
            process.stdout.write((s.BackendState || "Unknown") + " " + dns);
          } catch { process.stdout.write("Unknown "); }
        });
      ' 2>/dev/null || true
    }

    TS_STATUS=$(ts_status)
    TS_STATE="${TS_STATUS%% *}"    # empty input -> "" (exec failed)

    if [[ -z "$TS_AUTHKEY" && "$TS_STATE" != "Running" ]]; then
      # Node still needs login: surface the approval URL. On a re-run with
      # persisted state the node already joined - old URLs are dead.
      # --since is Compose v2-only; docker-compose v1 (accepted by
      # compose_cmd) errors on it. On v1, RECREATE the sidecar once before
      # the loop instead: only a new container starts with an empty log
      # buffer, so the scrape cannot resurface stale consumed URLs from
      # earlier runs (restart keeps the same container and its history).
      LOG_SINCE="--since $SCRIPT_START_EPOCH"
      if [[ "$COMPOSE" != "docker compose" ]]; then
        LOG_SINCE=""
        $COMPOSE rm -sf tailscale >/dev/null 2>&1 || true
        $COMPOSE up -d tailscale >/dev/null 2>&1 || true
      fi
      LOGIN_URL=""
      # On v2, skip the scrape when the sidecar does not answer status calls:
      # it is crash-looping and will never print a URL - let the wait loop
      # below hit its fast sidecar-down bail-out instead of burning the full
      # scrape window first. (v1 just recreated the container, so it always
      # scrapes.) Probe a few times before concluding: right after up -d,
      # tailscaled is often still booting and status transiently fails
      # ("Unknown") even on a healthy host.
      _p=0
      while [[ -z "$TS_STATE" || "$TS_STATE" == "Unknown" ]] && (( _p++ < 5 )); do
        sleep 2
        TS_STATUS=$(ts_status)
        TS_STATE="${TS_STATUS%% *}"
      done
      if [[ "$COMPOSE" != "docker compose" || -n "$TS_STATE" && "$TS_STATE" != "Unknown" ]]; then
        _i=0
        # while + (( )), not `for $(seq ...)`: stock macOS has no seq, and the
        # loop would silently run zero times there.
        while (( _i++ < 20 )); do
          LOGIN_URL=$($COMPOSE logs $LOG_SINCE tailscale 2>/dev/null | grep -o 'https://login\.tailscale\.com/a/[A-Za-z0-9]*' | tail -n 1 || true)
          [[ -n "$LOGIN_URL" ]] && break
          sleep 3
        done
      fi
      if [[ -n "$LOGIN_URL" ]]; then
        printf "\n"
        printf "  ${BOLD}Approve this node in your Tailscale account:${RESET}\n"
        printf "  ${CYAN}${BOLD}${LOGIN_URL}${RESET}\n"
        printf "  ${DIM}(up to 5 minutes - this continues automatically once approved)${RESET}\n\n"
      else
        warn "No login URL in the recent sidecar logs."
        hint "Run '${COMPOSE} restart tailscale' for a fresh URL, then watch"
        hint "'${COMPOSE} logs -f tailscale' and approve it - this setup keeps"
        hint "waiting and finishes automatically once you approve."
      fi
    fi

    TS_FQDN=""
    RUNNING_NO_DNS=0
    TS_DOWN=0
    TS_MAX_WAIT=30  # ~90 s with a pre-set auth key
    [[ -z "$TS_AUTHKEY" && "$TS_STATE" != "Running" ]] && TS_MAX_WAIT=100  # ~5 min for manual approval
    # while + (( )), not `for $(seq ...)`: stock macOS has no seq.
    _i=0
    while (( _i++ < TS_MAX_WAIT )); do
      TS_STATUS=$(ts_status)
      TS_STATE="${TS_STATUS%% *}"    # empty input -> "" (exec failed)
      TS_FQDN="${TS_STATUS#* }"
      [[ -n "$TS_FQDN" ]] && break
      if [[ "$TS_STATE" == "Running" ]]; then
        TS_DOWN=0
        # Running without a DNS name may be the transient window right after
        # approval (DNSName fills in shortly after Running) - require ~10
        # consecutive observations (~30 s) before concluding MagicDNS/HTTPS
        # certificates are disabled.
        (( RUNNING_NO_DNS++ >= 10 )) && break
      elif [[ "$TS_STATE" == "NeedsLogin" ]]; then
        # Sidecar is healthy and waiting for approval - keep polling.
        RUNNING_NO_DNS=0
        TS_DOWN=0
      else
        # Healthy-but-not-Running states (Starting, NeedsMachineAuth) still
        # answer status calls - keep polling them within TS_MAX_WAIT. Only
        # failed status calls ("", Unknown) mean a down/crash-looping sidecar
        # (e.g. /dev/net/tun denied): bail out early instead of stalling the
        # whole window on a "pending approval" that never was.
        RUNNING_NO_DNS=0
        if [[ -z "$TS_STATE" || "$TS_STATE" == "Unknown" ]]; then
          (( TS_DOWN++ >= 10 )) && break
        else
          TS_DOWN=0
        fi
      fi
      # Quiet progress feedback: one dim dot per poll (3 s), so a long wait
      # reads as "alive" instead of hung.
      printf "${GRAY}.${RESET}"
      sleep 3
    done
    printf "\n"

    if [[ -n "$TS_FQDN" ]]; then
      ENV_OK="true"
      env_set WEB_GUI_HOST "$TS_FQDN"           || ENV_OK="false"
      env_set PASSKEY_RP_ID "$TS_FQDN"          || ENV_OK="false"
      env_set PASSKEY_ORIGIN "https://$TS_FQDN" || ENV_OK="false"
      if [[ "$ENV_OK" != "true" ]]; then
        warn "Could not write the real hostname into .env."
        hint "Set WEB_GUI_HOST=$TS_FQDN, PASSKEY_RP_ID=$TS_FQDN and"
        hint "PASSKEY_ORIGIN=https://$TS_FQDN in .env, then:"
        hint "docker compose up -d web-gui"
      fi
      WEB_GUI_HOST="$TS_FQDN"
      PASSKEY_RP_ID="$TS_FQDN"
      PASSKEY_ORIGIN="https://$TS_FQDN"
      # Joined: with TS_AUTH_ONCE=true the key is no longer needed (state
      # persists in the tailscale-state volume) - shorten the window a valid
      # tailnet key sits in a credentials-bearing file.
      if [[ -n "$TS_AUTHKEY" ]]; then
        env_set TS_AUTHKEY "" || warn "Could not blank TS_AUTHKEY in .env - remove it manually once joined."
      fi
      # Recreate web-gui so the real hostname lands in the container env.
      RECREATE_OUT=$($COMPOSE up -d web-gui 2>&1) || {
        warn "web-gui was not recreated with the new hostname."
        hint "Run: docker compose up -d web-gui - until then the GUI keeps"
        hint "placeholder WEB_GUI_HOST/PASSKEY_* values."
        printf '%s\n' "$RECREATE_OUT" | tail -n 5 | sed 's/^/    /'
      }
      ok "Joined your tailnet as https://$TS_FQDN"
    else
      if [[ "$TS_STATE" == "Running" ]]; then
        warn "Joined, but MagicDNS returned no DNS name."
        hint "Enable MagicDNS + HTTPS certificates in the Tailscale admin"
        hint "console (DNS tab), then restart the sidecar"
        hint "(${COMPOSE} restart tailscale) and read the name:"
        hint "  ${COMPOSE} exec tailscale tailscale status --json"
        hint "Set WEB_GUI_HOST and PASSKEY_RP_ID in .env to that name (bare),"
        hint "PASSKEY_ORIGIN to https://<that-name>, then:"
        hint "${COMPOSE} up -d web-gui"
      elif [[ -z "$TS_STATE" || "$TS_STATE" == "Unknown" ]]; then
        warn "The Tailscale sidecar is not responding to status checks."
        hint "It is probably crash-looping - check: docker compose logs tailscale"
        hint "On hosts that deny /dev/net/tun (unprivileged LXC, rootless"
        hint "Docker) the sidecar cannot start; re-run ./init.sh to pick a"
        hint "different access mode."
      else
        warn "The node did not join within the wait window."
        if [[ -n "$TS_AUTHKEY" ]]; then
          hint "The auth key may be expired or already used - create a new one"
          hint "under Admin console -> Settings -> Keys, put it in TS_AUTHKEY"
          hint "(.env), then run: ${COMPOSE} up -d tailscale"
        else
          hint "Check '${COMPOSE} logs -f tailscale' for the login URL."
          hint "After approving, set in .env:"
          hint "  WEB_GUI_HOST=<name>.<tailnet>.ts.net"
          hint "  PASSKEY_RP_ID=<name>.<tailnet>.ts.net   (bare DNS name - no https://)"
          hint "  PASSKEY_ORIGIN=https://<name>.<tailnet>.ts.net"
          hint "then run: ${COMPOSE} up -d web-gui"
        fi
      fi
    fi
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
if [[ "$TAILSCALE_ENABLED" == "true" ]]; then
  printf "\n"
  printf "  ${DIM}Tailscale: only devices logged into your tailnet can reach the GUI -${RESET}\n"
  printf "  ${DIM}nothing is published to the LAN or the internet. This machine keeps${RESET}\n"
  printf "  ${DIM}its local access at http://localhost:${WEB_GUI_PORT} (password + TOTP only -${RESET}\n"
  printf "  ${DIM}passkeys are bound to the ts.net name and fail on localhost).${RESET}\n"
  if [[ -n "${TS_FQDN:-}" ]]; then
    printf "  ${DIM}Remote: https://${TS_FQDN}${RESET}\n"
  else
    printf "  ${DIM}Remote: join pending - once the stack is up (${COMPOSE} up -d),${RESET}\n"
    printf "  ${DIM}${COMPOSE} logs -f tailscale shows the login URL. After approving:${RESET}\n"
    printf "  ${DIM}set WEB_GUI_HOST and PASSKEY_RP_ID in .env to <name>.<tailnet>.ts.net${RESET}\n"
    printf "  ${DIM}(bare DNS name), PASSKEY_ORIGIN to https://<same>, then run${RESET}\n"
    printf "  ${DIM}${COMPOSE} up -d web-gui (passkeys stay broken until then).${RESET}\n"
  fi
  printf "  ${DIM}Prerequisites (one-time, Tailscale admin console): MagicDNS and${RESET}\n"
  printf "  ${DIM}HTTPS certificates enabled. Optional hardening: tag the node${RESET}\n"
  printf "  ${DIM}(TS_EXTRA_ARGS=--advertise-tags=tag:nexus) and scope tailnet ACLs${RESET}\n"
  printf "  ${DIM}to it (dst tag:nexus:443). Sidecar logs: docker compose logs -f tailscale${RESET}\n"
fi
printf "\n"

# ── Open browser ──────────────────────────────────────────────────────────────
if [[ "$START" == "yes" ]]; then
  # Tailscale mode: the local browser reaches the loopback publish - the
  # ts.net URL needs a tailnet login this machine may not have.
  if [[ "$TAILSCALE_ENABLED" == "true" ]]; then
    OPEN_URL="http://localhost:${WEB_GUI_PORT}/setup"
  else
    OPEN_URL="${PASSKEY_ORIGIN}/setup"
  fi

  # Give the web-gui container a moment to finish starting
  sleep 2

  # Open the browser (macOS: open, Linux: xdg-open, WSL: cmd.exe)
  if command -v open &>/dev/null; then
    open "$OPEN_URL"
  elif command -v xdg-open &>/dev/null; then
    xdg-open "$OPEN_URL"
  elif command -v cmd.exe &>/dev/null; then
    cmd.exe /c start "" "$OPEN_URL"
  else
    printf "  ${YELLOW}▲${RESET}  Could not detect a browser opener. Visit manually:\n"
    printf "     ${CYAN}${OPEN_URL}${RESET}\n\n"
  fi
fi
