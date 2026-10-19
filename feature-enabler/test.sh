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

# 12. upgrade web-gui: pulls first, then flips pins, saves PREVIOUS_*, moves core
: > "$DOCKER_LOG"
cat > "$PROJ/.env" << EOF
NETWORK=mainnet
SESSION_SECRET=secret-do-not-touch
WEB_GUI_IMAGE=ghcr.io/mintlayer/web-gui/web-gui:v1.0.0-rc2
ML_NODE_DAEMON_IMAGE=ghcr.io/mintlayer/web-gui/node-daemon:v1.0.0-rc2
EOF
req web-gui.req '{"action":"upgrade","service":"web-gui","tag":"v1.0.0-rc3","bitcoind":"26"}'
run_enabler || fail "enabler exited non-zero (case 13)"
grep -q '"ok":true' "$REQ/web-gui.result" || fail "upgrade result not ok (case 13)"
pulls=$(grep -c '^pull ghcr.io/' "$DOCKER_LOG")
[ "$pulls" -eq 7 ] || fail "expected 7 pulls, got $pulls (case 13)"
grep -q '^pull bitcoin/bitcoin:26$' "$DOCKER_LOG" || fail "declared core not pulled (case 13)"
grep -q '^WEB_GUI_IMAGE=ghcr.io/mintlayer/web-gui/web-gui:v1.0.0-rc3$' "$PROJ/.env" || fail "web pin not updated (case 13)"
grep -q '^PREVIOUS_WEB_GUI_IMAGE=ghcr.io/mintlayer/web-gui/web-gui:v1.0.0-rc2$' "$PROJ/.env" || fail "previous web pin not saved (case 13)"
grep -q '^BITCOIND_IMAGE=bitcoin/bitcoin:26$' "$PROJ/.env" || fail "core pin not set (case 13)"
grep -q '^MANAGED_BITCOIND_IMAGE=bitcoin/bitcoin:26$' "$PROJ/.env" || fail "managed core mirror not set (case 13)"
grep -q 'up -d web-gui' "$DOCKER_LOG" || fail "web-gui not recreated (case 13)"
grep -q 'SESSION_SECRET=secret-do-not-touch' "$PROJ/.env" || fail ".env secrets damaged (case 13)"
pass "upgrade pulls first, pins moved, core bumped"

# 13. upgrade with a failed pull changes nothing
: > "$DOCKER_LOG"
touch "$WORK/fail"
export DOCKER_FAIL="$WORK/fail"
req web-gui.req '{"action":"upgrade","service":"web-gui","tag":"v1.0.0-rc4"}'
run_enabler || fail "enabler exited non-zero (case 14)"
grep -q '"ok":false' "$REQ/web-gui.result" || fail "failed pull not reported (case 14)"
grep -q ':v1.0.0-rc3' "$PROJ/.env" || fail "env changed despite failed pull (case 14)"
unset DOCKER_FAIL
pass "failed pull aborts before env write"

# 14. user-pinned core is respected
: > "$DOCKER_LOG"
# update the pin in place (a real .env never carries duplicate keys)
sed -i 's|^BITCOIND_IMAGE=.*|BITCOIND_IMAGE=bitcoin/bitcoin:27|' "$PROJ/.env"
req web-gui.req '{"action":"upgrade","service":"web-gui","tag":"v1.0.0-rc4","bitcoind":"28"}'
run_enabler || fail "enabler exited non-zero (case 15)"
grep -q '^BITCOIND_IMAGE=bitcoin/bitcoin:27$' "$PROJ/.env" || fail "user core pin overwritten (case 15)"
grep -q '^MANAGED_BITCOIND_IMAGE=bitcoin/bitcoin:26$' "$PROJ/.env" || fail "managed mirror clobbered (case 15)"
pass "user-pinned core respected"

# 15. rollback restores the previous pins and clears the anchors
: > "$DOCKER_LOG"
req web-gui.req '{"action":"rollback","service":"web-gui"}'
run_enabler || fail "enabler exited non-zero (case 16)"
grep -q '"ok":true' "$REQ/web-gui.result" || fail "rollback result not ok (case 16)"
grep -q '^WEB_GUI_IMAGE=ghcr.io/mintlayer/web-gui/web-gui:v1.0.0-rc3$' "$PROJ/.env" || fail "rollback did not restore web pin (case 16)"
grep -q '^PREVIOUS_WEB_GUI_IMAGE=' "$PROJ/.env" && fail "rollback left stale anchor (case 16)"
grep -q '^BITCOIND_IMAGE=bitcoin/bitcoin:27$' "$PROJ/.env" || fail "rollback lost user core pin (case 16)"
grep -q '^PREVIOUS_BITCOIN_IMAGE=' "$PROJ/.env" && fail "rollback left core anchor (case 16)"
pass "rollback restores pins and clears anchors"

# 16. rollback without a previous version fails honestly
: > "$DOCKER_LOG"
req web-gui.req '{"action":"rollback","service":"web-gui"}'
run_enabler || fail "enabler exited non-zero (case 17)"
grep -q '"ok":false' "$REQ/web-gui.result" || fail "empty rollback not rejected (case 17)"
grep -q 'docker' "$DOCKER_LOG" && fail "docker called without previous pins (case 17)"
pass "rollback without previous fails honestly"

# 17. upgrade/rollback only restart services this install actually runs
: > "$DOCKER_LOG"
cat > "$PROJ/.env" << EOF
NETWORK=mainnet
SESSION_SECRET=secret-do-not-touch
WEB_GUI_IMAGE=ghcr.io/mintlayer/web-gui/web-gui:v1.0.0-rc2
EOF
req web-gui.req '{"action":"upgrade","service":"web-gui","tag":"v1.0.0-rc3"}'
run_enabler || fail "enabler exited non-zero (case 18)"
up_line=$(grep 'up -d node-daemon' "$DOCKER_LOG" | tail -1)
[ -n "$up_line" ] || fail "daemon up line missing (case 18)"
case "$up_line" in
    *bdk-wallet*|*btc-explorer*|*bitcoind*|*api-blockchain-scanner*) fail "disabled stacks in up list (case 18): $up_line" ;;
esac
printf 'BITCOIN_ENABLED=true\nINDEXER_ENABLED=true\n' >> "$PROJ/.env"
: > "$DOCKER_LOG"
req web-gui.req '{"action":"upgrade","service":"web-gui","tag":"v1.0.0-rc4"}'
run_enabler || fail "enabler exited non-zero (case 18b)"
up_line=$(grep 'up -d node-daemon' "$DOCKER_LOG" | tail -1)
for svc in bitcoind bdk-wallet btc-explorer api-blockchain-scanner-daemon api-web-server; do
    case "$up_line" in *" $svc"*) ;; *) fail "enabled $svc missing from up list (case 18b)" ;; esac
done
pass "up list follows enabled flags"

# 18. re-running the same upgrade is a no-op that keeps the rollback anchor
: > "$DOCKER_LOG"
cp "$PROJ/.env" "$WORK/env.before.18"
req web-gui.req '{"action":"upgrade","service":"web-gui","tag":"v1.0.0-rc4"}'
run_enabler || fail "enabler exited non-zero (case 19)"
grep -q '"ok":true' "$REQ/web-gui.result" || fail "same-target rerun not ok (case 19)"
pulls=$(grep -c '^pull ghcr.io/' "$DOCKER_LOG")
[ "$pulls" -eq 0 ] || fail "same-target rerun pulled $pulls images (case 19)"
grep -q 'up -d' "$DOCKER_LOG" && fail "same-target rerun restarted services (case 19)"
diff -q "$PROJ/.env" "$WORK/env.before.18" >/dev/null || fail "same-target rerun rewrote .env (case 19)"
pass "same-target upgrade is a clean no-op"

# 19. a declared core version that survives extraction but breaks policy is rejected
: > "$DOCKER_LOG"
req web-gui.req '{"action":"upgrade","service":"web-gui","tag":"v1.0.0-rc5","bitcoind":"26.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0"}'
run_enabler || fail "enabler exited non-zero (case 20)"
grep -q '"ok":false' "$REQ/web-gui.result" || fail "invalid bitcoind not rejected (case 20)"
grep -q 'invalid bitcoind' "$REQ/web-gui.result" || fail "invalid bitcoind reason (case 20)"
[ -s "$DOCKER_LOG" ] && fail "docker called with invalid bitcoind (case 20)"
pass "invalid declared core version rejects"

# 19b. shell metacharacters in the payload never reach docker (extraction
# drops them, the request proceeds without a core bump)
: > "$DOCKER_LOG"
req web-gui.req '{"action":"upgrade","service":"web-gui","tag":"v1.0.0-rc5","bitcoind":"26; touch /tmp/pwned"}'
run_enabler || fail "enabler exited non-zero (case 20b)"
rm -f /tmp/pwned
grep -q 'pull bitcoin' "$DOCKER_LOG" && fail "core pulled from hostile payload (case 20b)"
! grep -q 'touch\|;' "$DOCKER_LOG" || fail "metacharacters reached docker (case 20b)"
pass "hostile core payload degrades safely"

# 20. digest-pinned images abort with a clear message
: > "$DOCKER_LOG"
cat > "$PROJ/.env" << EOF
NETWORK=mainnet
SESSION_SECRET=secret-do-not-touch
WEB_GUI_IMAGE=ghcr.io/mintlayer/web-gui/web-gui@sha256:0000000000000000000000000000000000000000000000000000000000000000
EOF
req web-gui.req '{"action":"upgrade","service":"web-gui","tag":"v1.0.0-rc6"}'
run_enabler || fail "enabler exited non-zero (case 21)"
grep -q '"ok":false' "$REQ/web-gui.result" || fail "digest pin not rejected (case 21)"
grep -q 'digest-pinned' "$REQ/web-gui.result" || fail "digest pin reason (case 21)"
[ -s "$DOCKER_LOG" ] && fail "docker called on digest-pinned install (case 21)"
grep -q 'SESSION_SECRET=secret-do-not-touch' "$PROJ/.env" || fail ".env secrets damaged (case 21)"
pass "digest-pinned image aborts upgrade"

printf 'ALL ENABLER TESTS PASSED\n'
