#!/usr/bin/env bash
# Query transaction_list_pending from the wallet RPC and print JSON to stdout.
#
# Usage:
#   ./list-pending-transactions.sh [account]
#
# account defaults to 0 if not specified.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: .env file not found at $ENV_FILE" >&2
  exit 1
fi

# shellcheck disable=SC1090
source "$ENV_FILE"

ACCOUNT="${1:-0}"
HOST="${WALLET_RPC_HOST:-localhost}"
PORT="${WALLET_RPC_PORT:-3034}"
URL="http://${HOST}:${PORT}"
AUTH=$(printf '%s:%s' "$WALLET_RPC_USERNAME" "$WALLET_RPC_PASSWORD" | base64)

curl -sf \
  -H 'Content-Type: application/json' \
  -H "Authorization: Basic $AUTH" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"transaction_list_pending\",\"params\":{\"account\":${ACCOUNT}}}" \
  "$URL" | jq .
