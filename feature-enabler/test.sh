#!/bin/sh
# feature-enabler test harness — runs enabler.sh --once against a fake docker
# CLI and a scratch project, asserting the fixed action set, env-flag updates,
# allowlist rejections and result files. Exits non-zero on the first failure.
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
WORK=$(mktemp -d)
PATH_DIR="$WORK/bin"
PROJ="$WORK/project"
REQ="$WORK/requests"
mkdir -p "$PATH_DIR" "$PROJ" "$REQ"
trap 'rm -rf "$WORK"' EXIT

fail() { printf 'FAIL: %s\n' "$*"; exit 1; }
pass() { printf 'ok: %s\n' "$*"; }

# --- fake docker -----------------------------------------------------------
cat > "$PATH_DIR/docker" << 'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "$DOCKER_LOG"
if [ -n "${DOCKER_FAIL:-}" ] && [ -e "$DOCKER_FAIL" ]; then printf '%b' "${DOCKER_FAIL_MSG:-boom: compose failed}" | tr -d '\r\n' >&2; printf '\n' >&2; exit 1; fi
exit 0
EOF
chmod +x "$PATH_DIR/docker"
export DOCKER_LOG="$WORK/docker.log"
: > "$DOCKER_LOG"

# --- shared env -------------------------------------------------------------
cat > "$PROJ/.env" << 'EOF'
NETWORK=mainnet
SESSION_SECRET=secret-do-not-touch
BITCOIN_ENABLED=false
EOF

export PROJECT_DIR="$PROJ" ENV_FILE="$PROJ/.env" REQUESTS_DIR="$REQ" COMPOSE_FILES=docker-compose.yml

req() { # req FILE JSON
    printf '%s\n' "$2" > "$REQ/$1"
    sleep 0.01
}

envhas() { grep -q "^$1=$2$" "$PROJ/.env"; }

run_enabler() { PATH="$PATH_DIR:$PATH" sh "$HERE/enabler.sh" --once; }

# 1. enable bitcoin, pruned default (missing pruned field -> true)
req bitcoin.req '{"action":"enable","service":"bitcoin","network":"mainnet"}'
run_enabler || fail "enabler exited non-zero (case 1)"
envhas BITCOIN_ENABLED true || fail "BITCOIN_ENABLED not set (case 1)"
envhas BITCOIN_NETWORK mainnet || fail "BITCOIN_NETWORK not set (case 1)"
envhas BITCOIN_PRUNE 550 || fail "BITCOIN_PRUNE not pruned-default (case 1)"
envhas BITCOIN_TXINDEX 0 || fail "BITCOIN_TXINDEX not pruned-default (case 1)"
grep -q 'up -d' "$DOCKER_LOG" || fail "compose up not called (case 1)"
grep -q -- '--profile bitcoin' "$DOCKER_LOG" || fail "profile flag missing (case 1)"
grep -q '"ok":true' "$REQ/bitcoin.result" || fail "ok result missing (case 1)"
[ ! -e "$REQ/bitcoin.req" ] && [ ! -e "$REQ/bitcoin.req.lock" ] || fail "request not consumed (case 1)"
grep -q 'SESSION_SECRET=secret-do-not-touch' "$PROJ/.env" || fail ".env secrets damaged (case 1)"
pass "enable bitcoin pruned default"

# 2. enable bitcoin, explicit pruned=false replaces existing keys
: > "$DOCKER_LOG"
req bitcoin.req '{"action":"enable","service":"bitcoin","network":"regtest","pruned":false}'
run_enabler || fail "enabler exited non-zero (case 2)"
envhas BITCOIN_PRUNE 0 || fail "PRUNE not 0 (case 2)"
envhas BITCOIN_TXINDEX 1 || fail "TXINDEX not 1 (case 2)"
envhas BITCOIN_NETWORK regtest || fail "NETWORK not replaced (case 2)"
pass "enable bitcoin full node replaces env keys"

# 3. invalid network rejected, env untouched, failure result
: > "$DOCKER_LOG"
cp "$PROJ/.env" "$WORK/env.before"
req bitcoin.req '{"action":"enable","service":"bitcoin","network":"signet"}'
run_enabler || fail "enabler exited non-zero (case 3)"
cmp -s "$PROJ/.env" "$WORK/env.before" || fail ".env changed on invalid request (case 3)"
grep -q '"ok":false' "$REQ/bitcoin.result" || fail "failure result missing (case 3)"
grep -q 'invalid network' "$REQ/bitcoin.result" || fail "wrong failure reason (case 3)"
[ -s "$DOCKER_LOG" ] && fail "docker called on invalid request (case 3)"
pass "invalid network rejected fail-closed"

# 4. compose failure produces ok:false with the error tail
: > "$DOCKER_LOG"
touch "$WORK/fail"
export DOCKER_FAIL="$WORK/fail"
req bitcoin.req '{"action":"enable","service":"bitcoin","network":"mainnet"}'
run_enabler || fail "enabler exited non-zero (case 4)"
grep -q '"ok":false' "$REQ/bitcoin.result" || fail "compose failure not reported (case 4)"
grep -q 'boom' "$REQ/bitcoin.result" || fail "error tail missing (case 4)"
pass "compose failure reported"

# 5. disable bitcoin stops services and recreates web-gui
: > "$DOCKER_LOG"
req bitcoin.req '{"action":"disable","service":"bitcoin"}'
run_enabler || fail "enabler exited non-zero (case 5)"
grep -q 'stop bitcoind btc-explorer bdk-wallet' "$DOCKER_LOG" || fail "stop services missing (case 5)"
grep -q 'up -d web-gui' "$DOCKER_LOG" || fail "web-gui recreate missing (case 5)"
envhas BITCOIN_ENABLED false || fail "BITCOIN_ENABLED not disabled (case 5)"
pass "disable bitcoin"

# 6. indexer enable/disable
: > "$DOCKER_LOG"
req indexer.req '{"action":"enable","service":"indexer"}'
run_enabler || fail "enabler exited non-zero (case 6)"
envhas INDEXER_ENABLED true || fail "INDEXER_ENABLED not set (case 6)"
grep -q -- '--profile indexer' "$DOCKER_LOG" || fail "indexer profile missing (case 6)"
: > "$DOCKER_LOG"
req indexer.req '{"action":"disable","service":"indexer"}'
run_enabler || fail "enabler exited non-zero (case 7)"
grep -q 'stop postgres api-blockchain-scanner-daemon api-web-server' "$DOCKER_LOG" || fail "indexer stop missing (case 7)"
envhas INDEXER_ENABLED false || fail "INDEXER_ENABLED not disabled (case 7)"
pass "indexer enable/disable"

# 7. unknown file removed, invalid action result
req evil.req '{"action":"enable","service":"node"}'
req bitcoin.req '{"action":"reboot","service":"bitcoin"}'
run_enabler || fail "enabler exited non-zero (case 8)"
[ ! -e "$REQ/evil.req" ] || fail "unknown file kept (case 8)"
grep -q '"ok":false' "$REQ/bitcoin.result" || fail "invalid action result missing (case 8)"
grep -q 'invalid action' "$REQ/bitcoin.result" || fail "invalid action reason (case 8)"
pass "unknown file + invalid action rejected"

# 8. stale request archived untouched
: > "$DOCKER_LOG"
req bitcoin.req '{"action":"enable","service":"bitcoin","network":"mainnet"}'
touch -d '2 days ago' "$REQ/bitcoin.req"
run_enabler || fail "enabler exited non-zero (case 9)"
[ -e "$REQ/bitcoin.req.expired" ] || fail "stale request not archived (case 9)"
[ -s "$DOCKER_LOG" ] && fail "docker called for stale request (case 9)"
pass "stale request archived"

# 9. escaping: hostile error text cannot break the result JSON
: > "$DOCKER_LOG"
touch "$WORK/fail"
export DOCKER_FAIL="$WORK/fail" DOCKER_FAIL_MSG='boom \r CR \013 VT \303\251 utf8 "quoted" \\ backslash'
req bitcoin.req '{"action":"enable","service":"bitcoin","network":"mainnet"}'
run_enabler || fail "enabler exited non-zero (case 10)"
grep -q '"ok":false' "$REQ/bitcoin.result" || fail "escaping case result missing (case 10)"
node -e "JSON.parse(require('fs').readFileSync('$REQ/bitcoin.result','utf8'))" || fail "result is not valid JSON (case 10)"
unset DOCKER_FAIL DOCKER_FAIL_MSG
pass "error text escaped into valid JSON"

# 10. stale lock recovery: an interrupted apply is retried after restart
: > "$DOCKER_LOG"
printf '%s\n' '{"action":"disable","service":"bitcoin"}' > "$REQ/bitcoin.req.lock"
run_enabler || fail "enabler exited non-zero (case 11)"
[ -e "$REQ/bitcoin.req.lock" ] && fail "stale lock not recovered (case 11)"
grep -q '"ok":true' "$REQ/bitcoin.result" || fail "recovered request not applied (case 11)"
pass "stale lock recovered and applied"

# 11. non-regular files in the watch dir are removed, not followed
: > "$DOCKER_LOG"
mkdir -p "$REQ/indexer.req"
run_enabler || fail "enabler exited non-zero (case 12)"
[ -e "$REQ/indexer.req" ] && fail "directory request not removed (case 12)"
[ -s "$DOCKER_LOG" ] && fail "docker called on directory request (case 12)"
pass "non-regular request ignored"

printf 'ALL ENABLER TESTS PASSED\n'
