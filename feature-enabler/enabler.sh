#!/bin/sh
# feature-enabler — applies "enable/disable optional service" requests from the
# web-gui without giving the web container access to the Docker socket.
#
# The web-gui writes a small JSON request file into the shared feature-requests
# volume. This agent (the ONLY container besides watchtower with a Docker
# socket, and the only one with the compose project mounted writable) watches
# that directory and performs one of a FIXED set of actions:
#
#   enable  bitcoin  -> set BITCOIN_ENABLED/NETWORK/PRUNE/TXINDEX in .env,
#                       docker compose --profile bitcoin up -d
#   disable bitcoin  -> stop bitcoind/btc-explorer/bdk-wallet, set
#                       BITCOIN_ENABLED=false, recreate web-gui
#   enable  indexer  -> set INDEXER_ENABLED=true, --profile indexer up -d
#   disable indexer  -> stop postgres/scanner/web-server, set flag, recreate
#   upgrade web-gui  -> pull every image at the release tag, THEN flip the
#                       image pins in .env (previous pins saved as PREVIOUS_*),
#                       recreate daemons then web-gui. Optionally moves
#                       Bitcoin Core when the release declares a tested
#                       version and the user hasn't pinned their own.
#   rollback web-gui -> restore the PREVIOUS_* pins and recreate.
#
# Request contents are validated against fixed allowlists; nothing from the
# request file is ever passed to a shell. Secrets in .env are never read into
# the agent beyond the single-line sed replacement of the keys above, and no
# .env values are logged. Results are written to <service>.result for the UI.
#
# Overridable environment:
#   PROJECT_DIR    compose project directory (default /project)
#   ENV_FILE       env file to update            (default $PROJECT_DIR/.env)
#   COMPOSE_FILES  colon-separated compose files (default docker-compose.yml)
#   REQUESTS_DIR   watch directory               (default /requests)
#   POLL_SECS      poll interval                 (default 5)
set -u

PROJECT_DIR="${PROJECT_DIR:-/project}"
ENV_FILE="${ENV_FILE:-$PROJECT_DIR/.env}"
REQUESTS_DIR="${REQUESTS_DIR:-/requests}"
POLL_SECS="${POLL_SECS:-5}"
MAX_REQ_AGE_SECS="${MAX_REQ_AGE_SECS:-86400}"
MAX_ERR_CHARS=400

log() { printf '[feature-enabler] %s\n' "$*"; }

compose() {
    # shellcheck disable=SC2086
    # --env-file pins interpolation to the same file the toggles rewrite, so
    # the service flags the enabler writes are the ones compose reads (the
    # default $PROJECT_DIR/.env only exists in installer deployments; dev
    # stacks point ENV_FILE at .env.dev via ENV_FILE_HOST).
    docker compose \
        --env-file "$ENV_FILE" \
        $(for f in $(printf '%s' "$COMPOSE_FILES" | tr ':' ' '); do printf ' -f %s/%s' "$PROJECT_DIR" "$f"; done) \
        --project-directory "$PROJECT_DIR" \
        "$@"
}

# set_env_key FILE KEY VALUE — replace "KEY=" in place or append "KEY=VALUE".
# Values here are always from fixed enum sets (true/false/network names/
# numbers), never user free-text.
# The write is an in-place truncate+rewrite (cat > file) instead of sed -i:
# sed -i renames a temp file over the target, which fails on the single-file
# bind mount the sidecar uses for .env. TMP (outside the read-only project
# mount) holds the rewritten copy until it is copied into place.
# NOTE: helpers below must NOT touch loop-variable names (key/svc/ref/tag):
# POSIX sh functions share globals, and a clobbered $key inside the upgrade
# loop once redirected pin writes to PREVIOUS_<key> (rc3 pre-release bug).
set_env_key() { # FILE KEY VALUE — replace "KEY=..." in place, appending when missing
    _f="$1" _k="$2" _v="$3"
    # The temp copy carries the whole .env (secrets included): 0600 only, and
    # gone even when awk dies mid-rewrite.
    _umask=$(umask); umask 077
    _tmp="${TMPDIR:-/tmp}/env-key.$$"
    if awk -v k="$_k" -v v="$_v" \
        '$0 ~ "^"k"=" { if (!done) { print k"="v; done=1 }; next } { print } END { if (!done) print k"="v }' \
        "$_f" > "$_tmp" 2>/dev/null; then
        cat "$_tmp" > "$_f"
    fi
    rm -f "$_tmp"
    umask "$_umask"
}

# write_result SERVICE OK ERROR — result file for the settings UI.
write_result() {
    service="$1" ok="$2" error="${3:-}"
    err_json=""
    if [ -n "$error" ]; then
        # ASCII-only tail: keeps the JSON valid even when cut mid-UTF-8-sequence;
        # remaining C0 controls are dropped (illegal inside JSON strings).
        error=$(printf '%s' "$error" | tail -c "$MAX_ERR_CHARS" | tr '\200-\377' '-' | tr '\n' ' ' | tr '\t' ' ' | tr -d '\000-\010\013\014\016-\037')
        # crude but sufficient escaping for the fixed vocabulary of errors
        error=$(printf '%s' "$error" | sed 's/\\/\\\\/g; s/"/\\"/g')
        err_json=",\"error\":\"$error\""
    fi
    printf '{"ok":%s,"at":%s%s}\n' "$ok" "$(date +%s000)" "$err_json" \
        > "$REQUESTS_DIR/$service.result.tmp" && mv "$REQUESTS_DIR/$service.result.tmp" "$REQUESTS_DIR/$service.result"
}

bitcoin_services="bitcoind btc-explorer bdk-wallet"
indexer_services="postgres api-blockchain-scanner-daemon api-web-server"

# Upgrade set: KEY_IN_ENV COMPOSE_SERVICE — image name inside the ghcr repo
# equals the compose service name for all of these.
UPGRADE_KEYS="ML_NODE_DAEMON_IMAGE:node-daemon ML_WALLET_RPC_DAEMON_IMAGE:wallet-rpc-daemon WEB_GUI_IMAGE:web-gui BDK_WALLET_IMAGE:bdk-wallet BTC_EXPLORER_IMAGE:btc-explorer ML_API_SCANNER_IMAGE:api-blockchain-scanner-daemon ML_API_WEB_SERVER_IMAGE:api-web-server"
UPGRADE_REPO_BASE="ghcr.io/mintlayer/web-gui"

delete_env_key() { # FILE KEY — drop "KEY=" (used to clear consumed PREVIOUS_* pins)
    _f="$1" _k="$2"
    _umask=$(umask); umask 077
    _tmp="${TMPDIR:-/tmp}/env-key.$$"
    if awk -v k="$_k" '$0 ~ "^"k"=" { next } { print }' "$_f" > "$_tmp" 2>/dev/null; then
        cat "$_tmp" > "$_f"
    fi
    rm -f "$_tmp"
    umask "$_umask"
}

get_env_key() { # KEY -> stdout: current value or empty when unset
    grep -m1 "^$1=" "$ENV_FILE" 2>/dev/null | cut -d= -f2-
}

# image_base VALUE — strip the tag (everything from the last colon).
image_base() { printf '%s' "$1" | sed 's/:[^:]*$//' ; }

# active_up_targets — services this install actually runs, per the .env flags.
# Naming a profiled service in `compose up` silently activates its profile,
# so disabled optional stacks (bitcoin, indexer) must never be listed here.
active_up_targets() {
    printf ' node-daemon wallet-rpc-daemon'
    if [ "$(get_env_key BITCOIN_ENABLED)" = "true" ]; then
        printf ' bitcoind bdk-wallet btc-explorer'
    fi
    if [ "$(get_env_key INDEXER_ENABLED)" = "true" ]; then
        printf ' api-blockchain-scanner-daemon api-web-server'
    fi
}

# apply_upgrade TAG BITCOIND — move all images to TAG (validated by caller).
apply_upgrade() {
    tag="$1" bitcoind="$2"
    [ -f "$ENV_FILE" ] || { log "env file missing: $ENV_FILE"; return 1; }

    # Resolve every current pin first; missing lines fall back to the compose
    # defaults so a fresh install without init.sh-written pins still upgrades.
    targets="${TMPDIR:-/tmp}/upgrade.targets.$$"
    : > "$targets"
    for pair in $UPGRADE_KEYS; do
        key=${pair%%:*} svc=${pair##*:}
        cur=$(get_env_key "$key")
        [ -n "$cur" ] || cur="$UPGRADE_REPO_BASE/$svc:latest"
        case "$cur" in
            *@*)  # digest-pinned references cannot take a new tag
                rm -f "$targets"
                log "aborting upgrade: $key is digest-pinned ($cur); unpin it or upgrade from the host"
                return 1 ;;
        esac
        base=$(image_base "$cur")
        # Already at the target: a re-run must not clobber the rollback anchor.
        [ "$cur" = "$base:$tag" ] && continue
        printf '%s %s %s\n' "$key" "$svc" "$base:$tag" >> "$targets"
    done

    # Bitcoin Core: only when the release declares a version AND we manage the
    # pin (absent = compose default; or equal to our MANAGED mirror). A user's
    # own BITCOIN_IMAGE pin is respected and never overwritten.
    bump_bitcoind=""
    if [ -n "$bitcoind" ]; then
        managed=$(get_env_key MANAGED_BITCOIND_IMAGE)
        cur=$(get_env_key BITCOIND_IMAGE)
        if [ "$cur" = "bitcoin/bitcoin:$bitcoind" ]; then
            log "core already at $bitcoind; leaving the pin alone"
        elif [ -z "$cur" ] || [ "$cur" = "$managed" ]; then
            if docker pull "bitcoin/bitcoin:$bitcoind" >/dev/null 2>&1; then
                bump_bitcoind="bitcoin/bitcoin:$bitcoind"
            else
                log "WARNING: declared bitcoind $bitcoind could not be pulled; leaving core as is"
            fi
        else
            log "respecting user-pinned BITCOIN_IMAGE=$cur; skipping declared core $bitcoind"
        fi
    fi

    if ! [ -s "$targets" ] && [ -z "$bump_bitcoind" ]; then
        rm -f "$targets"
        log "already running tag $tag; nothing to do"
        return 0
    fi

    # Pull everything BEFORE touching .env: a failed pull changes nothing.
    pull_failed=""
    while read -r key svc ref; do
        log "pulling $ref"
        docker pull "$ref" >/dev/null 2>&1 < /dev/null || pull_failed="$pull_failed $svc"
    done < "$targets"
    # Save the rollback anchors (only for keys that actually move), then flip.
    while read -r key svc ref; do
        set_env_key "$ENV_FILE" "PREVIOUS_$key" "$(get_env_key "$key")"
        set_env_key "$ENV_FILE" "$key" "$ref"
    done < "$targets"
    rm -f "$targets"
    if [ -n "$bump_bitcoind" ]; then
        set_env_key "$ENV_FILE" PREVIOUS_BITCOIN_IMAGE "$(get_env_key BITCOIND_IMAGE)"
        set_env_key "$ENV_FILE" BITCOIND_IMAGE "$bump_bitcoind"
        set_env_key "$ENV_FILE" MANAGED_BITCOIND_IMAGE "$bump_bitcoind"
    fi

    log "starting upgraded services (tag $tag)"
    # Optional stacks restart only when their .env flag says they run; the
    # core pin lands with the next enable when bitcoin is off.
    compose up -d$(active_up_targets)
    compose up -d web-gui
}

apply_rollback() {
    [ -f "$ENV_FILE" ] || { log "env file missing: $ENV_FILE"; return 1; }
    prev_web=$(get_env_key PREVIOUS_WEB_GUI_IMAGE)
    [ -n "$prev_web" ] || { log "no previous version saved"; return 1; }
    log "rolling back to $prev_web"
    while read -r key _svc _ref; do
        prev=$(get_env_key "PREVIOUS_$key")
        [ -n "$prev" ] && set_env_key "$ENV_FILE" "$key" "$prev"
        delete_env_key "$ENV_FILE" "PREVIOUS_$key"
    done << EOF
$(for pair in $UPGRADE_KEYS; do printf '%s - -\n' "${pair%%:*}"; done)
EOF
    prev_core=$(get_env_key PREVIOUS_BITCOIN_IMAGE)
    # consume the anchor even when it was empty (fresh installs have no core pin)
    delete_env_key "$ENV_FILE" PREVIOUS_BITCOIN_IMAGE
    if [ -n "$prev_core" ]; then
        set_env_key "$ENV_FILE" BITCOIND_IMAGE "$prev_core"
        set_env_key "$ENV_FILE" MANAGED_BITCOIND_IMAGE "$prev_core"
    fi
    log "restarting services on rolled-back pins"
    compose up -d$(active_up_targets)
    compose up -d web-gui
}

# apply_request ACTION SERVICE NETWORK PRUNED — returns 0 on success.
# Every branch is a fixed command; parameters come from validated enums only.
apply_request() {
    action="$1" service="$2" network="$3" pruned="$4" tag="$5" bitcoind="$6"

    case "$action:$service" in
        enable:bitcoin)
            [ -f "$ENV_FILE" ] || { log "env file missing: $ENV_FILE"; return 1; }
            prune_flag=0; txindex_flag=1
            [ "$pruned" = "true" ] && { prune_flag=550; txindex_flag=0; }
            # bitcoind's command line interpolates BITCOIN_CORE_CHAIN/TXINDEX/
            # PRUNE from .env, so the flags must be in place BEFORE the profile
            # up. On a compose failure the file keeps the new flags while no
            # container changed — benign and converges on retry (documented).
            set_env_key "$ENV_FILE" BITCOIN_ENABLED true
            set_env_key "$ENV_FILE" BITCOIN_NETWORK "$network"
            # Bitcoin Core's -chain flag wants "main" for mainnet (same mapping
            # init.sh uses); anything else passes through.
            core_chain="main"
            [ "$network" != "mainnet" ] && core_chain="$network"
            set_env_key "$ENV_FILE" BITCOIN_CORE_CHAIN "$core_chain"
            set_env_key "$ENV_FILE" BITCOIN_PRUNE "$prune_flag"
            set_env_key "$ENV_FILE" BITCOIN_TXINDEX "$txindex_flag"
            log "enabled bitcoin network=$network pruned=$pruned, starting containers"
            # Explicit service lists: a profile-wide `up -d` would also
            # recreate any other service whose config-hash changed — including
            # this sidecar itself (killing the request mid-flight) and web-gui.
            compose --profile bitcoin up -d bitcoind btc-explorer bdk-wallet
            compose up -d web-gui
            ;;
        disable:bitcoin)
            log "stopping bitcoin services"
            compose stop $bitcoin_services
            set_env_key "$ENV_FILE" BITCOIN_ENABLED false
            compose up -d web-gui
            ;;
        enable:indexer)
            [ -f "$ENV_FILE" ] || { log "env file missing: $ENV_FILE"; return 1; }
            set_env_key "$ENV_FILE" INDEXER_ENABLED true
            log "enabling indexer, starting containers"
            # Explicit service list — see the bitcoin branch above.
            compose --profile indexer up -d postgres api-blockchain-scanner-daemon api-web-server
            compose up -d web-gui
            ;;
        disable:indexer)
            log "stopping indexer services"
            compose stop $indexer_services
            set_env_key "$ENV_FILE" INDEXER_ENABLED false
            compose up -d web-gui
            ;;
        upgrade:web-gui)
            apply_upgrade "$tag" "$bitcoind"
            ;;
        rollback:web-gui)
            apply_rollback
            ;;
        *)
            log "rejected unknown action/service: $action/$service"
            return 1
            ;;
    esac
}

# process_file PATH — validate + claim + apply one request file.
process_file() {
    path="$1"
    name=$(basename "$path")
    case "$name" in
        bitcoin.req)  service="bitcoin" ;;
        indexer.req)  service="indexer" ;;
        web-gui.req)  service="web-gui" ;;
        *)            log "ignoring unexpected file: $name"; rm -f "$path"; return 0 ;;
    esac

    # Reject stale requests (agent was down longer than a day — assume moot).
    now=$(date +%s)
    mtime=$(stat -c %Y "$path" 2>/dev/null || echo "$now")
    if [ $((now - mtime)) -gt "$MAX_REQ_AGE_SECS" ]; then
        write_result "$service" false "request expired (the enabler was not running for over a day)"
        log "expired request archived: $name"
        mv "$path" "$path.expired"
        return 0
    fi

    # Only regular files are processed: a compromised web container could
    # plant a symlink to a device/FIFO (cat would block or OOM) or a
    # directory (would loop forever through the unreadable branch).
    if [ ! -f "$path" ]; then
        log "ignoring non-regular file: $name"
        if [ -d "$path" ]; then rm -rf "$path"; else rm -f "$path"; fi
        return 0
    fi

    payload=$(cat "$path") || { log "unreadable request: $name"; rm -f "$path"; return 0; }
    action=$(printf '%s' "$payload" | grep -o '"action":"[a-z]*"' | head -1 | cut -d'"' -f4)
    network=$(printf '%s' "$payload" | grep -o '"network":"[a-z]*"' | head -1 | cut -d'"' -f4)
    pruned=$(printf '%s' "$payload" | grep -o '"pruned":[^,}]*' | head -1 | cut -d: -f2 | tr -d '"')
    tag=$(printf '%s' "$payload" | grep -o '"tag":"[A-Za-z0-9._-]*"' | head -1 | cut -d'"' -f4)
    bitcoind=$(printf '%s' "$payload" | grep -o '"bitcoind":"[A-Za-z0-9._-]*"' | head -1 | cut -d'"' -f4)

    case "$action:$service" in
        enable:bitcoin|disable:bitcoin|enable:indexer|disable:indexer|upgrade:web-gui|rollback:web-gui) ;;
        *) write_result "$service" false "invalid action"; rm -f "$path"; return 0 ;;
    esac
    if [ "$action" = "upgrade" ]; then
        # v-prefixed release tag, shell-safe charset — re-checked here even
        # though the web side validated it: the volume is a trust boundary.
        case "$tag" in v[0-9]*) [ ${#tag} -le 40 ] || tag="" ;; *) tag="" ;; esac
        [ -n "$tag" ] || { write_result "$service" false "invalid release tag"; rm -f "$path"; return 0; }
        case "$bitcoind" in '') ;; [0-9]*) [ ${#bitcoind} -le 32 ] || { write_result "$service" false "invalid bitcoind version"; rm -f "$path"; return 0; } ;; *) write_result "$service" false "invalid bitcoind version"; rm -f "$path"; return 0 ;; esac
    fi
    # network/pruned only accompany enable requests
    if [ "$action" = "enable" ] && [ "$service" = "bitcoin" ]; then
        case "$network" in mainnet|testnet|regtest) ;; *) write_result "$service" false "invalid network"; rm -f "$path"; return 0 ;; esac
        [ "$pruned" = "true" ] || [ "$pruned" = "false" ] || pruned="true"
    fi

    mv "$path" "$path.lock" || return 0
    log "applying $action $service"
    if err=$(apply_request "$action" "$service" "$network" "$pruned" "$tag" "$bitcoind" 2>&1); then
        write_result "$service" true
        log "done: $action $service"
    else
        write_result "$service" false "${err:-compose failed}"
        log "FAILED: $action $service"
    fi
    rm -f "$path.lock"
}

main_loop() {
    log "watching $REQUESTS_DIR (project: $PROJECT_DIR, files: $COMPOSE_FILES)"
    while :; do
        for f in "$REQUESTS_DIR"/*.req; do
            [ -e "$f" ] || break
            process_file "$f"
        done
        sleep "$POLL_SECS"
    done
}

# Fail fast (visibly) when the compose plugin is missing from the CLI image.
# Watch mode only — --once is the test/integration path with a fake CLI.

# A crash mid-apply strands "<service>.req.lock" (invisible to both the scan
# glob and the web side's pending check). On startup, hand them back for a
# fresh pass — every action is idempotent, so a retry converges. A newer
# request queued while the sidecar was down wins: the stranded lock is
# archived instead, otherwise the recovery would clobber it.
recover_stale_locks() {
    for l in "$REQUESTS_DIR"/*.req.lock; do
        [ -e "$l" ] || return 0
        if [ -e "${l%.lock}" ]; then
            log "stale lock $(basename "$l") loses to a newer request; archiving"
            mv "$l" "$l.expired"
            continue
        fi
        log "recovering interrupted request: $(basename "$l")"
        mv "$l" "${l%.lock}"
    done
}

case "${1:-}" in
    --once)
        recover_stale_locks
        for f in "$REQUESTS_DIR"/*.req; do
            [ -e "$f" ] || break
            process_file "$f"
        done
        ;;
    ""|--watch)
        if ! docker compose version >/dev/null 2>&1; then
            log "WARNING: docker compose plugin not available — every request will fail"
        fi
        recover_stale_locks
        main_loop
        ;;
    *) log "usage: enabler.sh [--once|--watch]"; exit 2 ;;
esac
