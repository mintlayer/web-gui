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
    docker compose \
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
set_env_key() {
    file="$1" key="$2" value="$3"
    tmp="${TMPDIR:-/tmp}/env-key.$$"
    awk -v k="$key" -v v="$value" \
        '$0 ~ "^"k"=" { if (!done) { print k"="v; done=1 }; next } { print } END { if (!done) print k"="v }' \
        "$file" > "$tmp" 2>/dev/null && cat "$tmp" > "$file"
    rm -f "$tmp"
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

# apply_request ACTION SERVICE NETWORK PRUNED — returns 0 on success.
# Every branch is a fixed command; parameters come from validated enums only.
apply_request() {
    action="$1" service="$2" network="$3" pruned="$4"

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
            compose --profile bitcoin up -d
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
            compose --profile indexer up -d
            compose up -d web-gui
            ;;
        disable:indexer)
            log "stopping indexer services"
            compose stop $indexer_services
            set_env_key "$ENV_FILE" INDEXER_ENABLED false
            compose up -d web-gui
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

    case "$action" in enable|disable) ;; *) write_result "$service" false "invalid action"; rm -f "$path"; return 0 ;; esac
    # network/pruned only accompany enable requests
    if [ "$action" = "enable" ] && [ "$service" = "bitcoin" ]; then
        case "$network" in mainnet|testnet|regtest) ;; *) write_result "$service" false "invalid network"; rm -f "$path"; return 0 ;; esac
        [ "$pruned" = "true" ] || [ "$pruned" = "false" ] || pruned="true"
    fi

    mv "$path" "$path.lock" || return 0
    log "applying $action $service"
    if err=$(apply_request "$action" "$service" "$network" "$pruned" 2>&1); then
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
# fresh pass — every action is idempotent, so a retry converges.
recover_stale_locks() {
    for l in "$REQUESTS_DIR"/*.req.lock; do
        [ -e "$l" ] || return 0
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
