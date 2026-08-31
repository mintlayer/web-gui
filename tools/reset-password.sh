#!/usr/bin/env bash
# reset-password.sh — Reset the UI login password stored in ../.env
#
# Usage:
#   ./tools/reset-password.sh              # prompts for new password
#   ./tools/reset-password.sh mypassword   # non-interactive

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Error: .env not found at $ENV_FILE" >&2
  exit 1
fi

# Get password
if [[ $# -ge 1 ]]; then
  PASSWORD="$1"
else
  read -rsp "New UI password: " PASSWORD
  echo
  read -rsp "Confirm password: " PASSWORD2
  echo
  if [[ "$PASSWORD" != "$PASSWORD2" ]]; then
    echo "Error: passwords do not match." >&2
    exit 1
  fi
fi

if [[ -z "$PASSWORD" ]]; then
  echo "Error: password cannot be empty." >&2
  exit 1
fi

# Generate PBKDF2-SHA512 hash (matches src/lib/auth.ts format)
HASH=$(node -e "
const crypto = require('crypto');
const salt = crypto.randomBytes(32).toString('hex');
crypto.pbkdf2('$PASSWORD', salt, 210000, 64, 'sha512', (err, key) => {
  if (err) { process.stderr.write(err.message); process.exit(1); }
  console.log('pbkdf2:sha512:210000:' + salt + ':' + key.toString('hex'));
});
")

# Update or insert UI_PASSWORD_HASH in .env
if grep -q '^UI_PASSWORD_HASH=' "$ENV_FILE"; then
  # Use a temp file for portability (works on both macOS and Linux)
  tmp=$(mktemp)
  sed "s|^UI_PASSWORD_HASH=.*|UI_PASSWORD_HASH=$HASH|" "$ENV_FILE" > "$tmp"
  mv "$tmp" "$ENV_FILE"
else
  echo "UI_PASSWORD_HASH=$HASH" >> "$ENV_FILE"
fi

echo "Password updated in $ENV_FILE"
echo "Restart the web GUI for the change to take effect."
