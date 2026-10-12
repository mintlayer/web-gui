#!/usr/bin/env bash
# reset-password.sh — Reset the UI login password stored in the prefs database
#
# Usage:
#   ./tools/reset-password.sh              # prompts for new password (recommended)
#
# The password hash is written to the 'auth.password_hash' pref in
# mintlayer-data/prefs/mintlayer_prefs.sqlite — the same store the app reads
# (login.astro / password-change.ts). Any UI_PASSWORD_HASH line in .env is
# legacy and unused by the app; it is left untouched.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFS_DIR="$SCRIPT_DIR/../mintlayer-data/prefs"
PREFS_DB="$PREFS_DIR/mintlayer_prefs.sqlite"

if [[ ! -f "$PREFS_DB" ]]; then
  echo "Error: prefs database not found at $PREFS_DB" >&2
  echo "Run the installer first, or point this script at the right checkout." >&2
  exit 1
fi

# Get password (interactive only — argv mode leaked the password to the
# process list and shell history).
read -rsp "New UI password: " PASSWORD
echo
read -rsp "Confirm password: " PASSWORD2
echo
if [[ "$PASSWORD" != "$PASSWORD2" ]]; then
  echo "Error: passwords do not match." >&2
  exit 1
fi

if [[ -z "$PASSWORD" ]]; then
  echo "Error: password cannot be empty." >&2
  exit 1
fi

# Generate PBKDF2-SHA512 hash (matches src/lib/auth.ts format).
# Password is passed via env — never interpolated into the script (quoting)
# and never as argv (process list).
HASH=$(RESET_PASSWORD="$PASSWORD" node -e "
const crypto = require('crypto');
const salt = crypto.randomBytes(32).toString('hex');
crypto.pbkdf2(process.env.RESET_PASSWORD, salt, 210000, 64, 'sha512', (err, key) => {
  if (err) { process.stderr.write(err.message); process.exit(1); }
  console.log('pbkdf2:sha512:210000:' + salt + ':' + key.toString('hex'));
});
")
unset PASSWORD PASSWORD2

if ! command -v docker &>/dev/null; then
  echo "Error: docker is required to update the password (prefs DB lives in the app's volume)." >&2
  exit 1
fi

# 1) Write the new hash into the prefs DB. The hash format
#    pbkdf2:sha512:210000:<salthex>:<keyhex> is hex + colons, so it is safe to
#    interpolate into a single-quoted SQL literal.
# 2) Revoke existing UI sessions: session tokens are stateless HMACs that
#    embed auth.session_version. The COALESCE falls back to '1' (NOT '0'):
#    tokens are minted with version 0 by default, so bumping an absent row to
#    0 would be a no-op — '1' invalidates every existing session.
DB_OK=false
printf "INSERT OR REPLACE INTO prefs (key, value) VALUES ('auth.password_hash', '\"%s\"');\n" "$HASH" \
  | docker run --rm -i -v "$PREFS_DIR:/prefs" alpine \
      sh -c 'apk add -q --no-progress sqlite >/dev/null 2>&1 && sqlite3 /prefs/mintlayer_prefs.sqlite && chmod 600 /prefs/mintlayer_prefs.sqlite' \
  && DB_OK=true

if ! $DB_OK; then
  echo "Error: failed to update the prefs database — the password has NOT been changed." >&2
  exit 1
fi

printf "INSERT OR REPLACE INTO prefs (key, value) VALUES ('auth.session_version', COALESCE((SELECT CAST(CAST(value AS INTEGER) + 1 AS TEXT) FROM prefs WHERE key = 'auth.session_version'), '1'));\n" \
  | docker run --rm -i -v "$PREFS_DIR:/prefs" alpine \
      sh -c 'apk add -q --no-progress sqlite >/dev/null 2>&1 && sqlite3 /prefs/mintlayer_prefs.sqlite && chmod 600 /prefs/mintlayer_prefs.sqlite' \
  || { echo "Error: failed to revoke existing sessions (session_version bump)." >&2; exit 1; }

# The helper containers run as root; re-tighten ownership to the invoking
# user (same pattern as init.sh) so the app user keeps write access.
docker run --rm -v "$PREFS_DIR:/prefs" alpine \
  chown -R "$(id -u):$(id -g)" /prefs 2>/dev/null || true

# The app re-reads the prefs on every request — no restart needed.
echo "Password updated. All existing UI sessions have been signed out."
