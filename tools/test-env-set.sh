#!/usr/bin/env bash
# Smoke test for env_set() from init.sh - the credential-critical .env
# rewrite helper. Run from anywhere: ./tools/test-env-set.sh
#
# Covers: existing-key replace, missing-key append, trailing-newline
# normalization, newline-in-key/value rejection (exit non-zero, .env
# untouched), 0600 mode on rewrite, and stale temp-file handling.
# Also smoke-tests the ts_status() JSON parser extracted from init.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok: %s\n' "$1"; }
command -v node >/dev/null || fail "node is required (same prerequisite as init.sh)"

# ok - wrapper for expected-to-succeed env_set calls: a regression would
# otherwise abort under set -e without naming the failed case.
ok() { env_set "$@" || fail "env_set unexpectedly rejected [$*]"; }

# Extract only the env_set function body from init.sh. Guard that the range
# actually hit the closing brace: a reformatted init.sh would otherwise make
# sed emit the remainder of the file and source installer code here.
ENV_SET_FRAG="$(sed -n '/^env_set()/,/^}/p' "$ROOT/init.sh")" || fail "env_set extraction failed (init.sh missing or unreadable)"
[[ "$(tail -n 1 <<<"$ENV_SET_FRAG")" == "}" ]] || fail "env_set extraction truncated (missing closing brace)"
# shellcheck disable=SC1091
source <(printf '%s\n' "$ENV_SET_FRAG")
declare -f env_set >/dev/null || fail "could not extract env_set from init.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"

# mode PATH - file permissions, portable across GNU (stat -c) and BSD (stat -f).
mode() { stat -c %a "$1" 2>/dev/null || stat -f '%Lp' "$1"; }

# 1. Existing key replaced, missing key appended, trailing newline normalized.
printf 'FOO=1\nWEB_GUI_HOST=old' > .env # no trailing newline, on purpose
chmod 644 .env
ok WEB_GUI_HOST "nexus.tailabc.ts.net"
ok APPENDED_KEY "v"
grep -Fqx 'WEB_GUI_HOST=nexus.tailabc.ts.net' .env || fail "existing key not replaced"
grep -Fqx 'APPENDED_KEY=v' .env || fail "missing key not appended"
# Prefix-similar keys must survive: matching is startsWith(key + "=").
printf 'WEB_GUI_HOST=old\nWEB_GUI_HOST_EX=keep\n' > .env
ok WEB_GUI_HOST "nexus.tailabc.ts.net"
[[ "$(grep -Fcx 'WEB_GUI_HOST=nexus.tailabc.ts.net' .env)" == "1" ]] || fail "prefix-similar key present: target not replaced in place"
grep -Fqx 'WEB_GUI_HOST_EX=keep' .env || fail "prefix-similar key was rewritten"
# Duplicate keys in a hand-edited .env: env_set rewrites every matching line
# (no dedup), so both 'DUP=' lines become 'DUP=3'. Pin that behavior.
printf 'DUP=1\nOTHER=x\nDUP=2\n' > .env
ok DUP "3"
[[ "$(grep -cx 'DUP=3' .env)" == "2" ]] || fail "duplicate-key rewrite behavior changed"
# Indented / `export KEY=` lines must be rewritten in place (env_set trims
# and strips the export prefix); a regression appends a duplicate instead.
printf '  export WEB_GUI_HOST=old\n' > .env
ok WEB_GUI_HOST "nexus.tailabc.ts.net"
grep -Fqx 'WEB_GUI_HOST=nexus.tailabc.ts.net' .env || fail "indented/export key not replaced"
[[ "$(grep -cx 'WEB_GUI_HOST=nexus.tailabc.ts.net' .env)" == "1" ]] || fail "indented/export key duplicated"
[[ -z "$(tail -c 1 .env)" ]] || fail "trailing newline missing"
pass "replace + append + trailing newline"

# 2. Newline in key or value rejected; .env untouched.
cp .env before.env
out=$(env_set "EVIL
KEY" "x" 2>&1) && fail "newline in key accepted"
grep -q 'must not contain newlines' <<<"$out" || fail "newline in key rejected for an unrelated reason: $out"
out=$(env_set K2 "x
y" 2>&1) && fail "newline in value accepted"
grep -q 'must not contain newlines' <<<"$out" || fail "newline in value rejected for an unrelated reason: $out"
# Byte-exact (cmp, not $(cat) comparison): command substitution strips trailing
# newlines, which would hide a regression in the trailing-newline normalization.
cmp -s before.env .env || fail ".env modified by a rejected call"
pass "newline rejection"

# 3. .env ends up 0600 even when it started looser.
chmod 644 .env
ok WEB_GUI_HOST "nexus2.tailabc.ts.net"
[[ "$(mode .env)" == "600" ]] || fail "permissions not tightened to 0600"
pass "0600 mode"

# 3b. Special characters plausible in real credentials / production call
# sites (PASSKEY_ORIGIN carries '/:', compose expands $VAR in .env values).
# $ is rejected (compose would expand it in .env values) - explicit case:
out=$(env_set SPECIAL '$VAR' 2>&1) && fail "value with $ accepted"
grep -qF 'must not contain $' <<<"$out" || fail "value with $ rejected for an unrelated reason: $out"
for v in 'https://a.b.ts.net' 'a=b' 'p@ss"w'\''ord' ''; do
  ok SPECIAL "$v"
  [[ "$(grep -Fcx "SPECIAL=$v" .env)" == "1" ]] || fail "special value corrupted or duplicated: [$v]"
done
# Rejected CR calls must leave .env byte-identical and no temp residue:
# snapshot BEFORE (a later rewrite would destroy the evidence).
cp .env before-cr.env
out=$(env_set $'CR\rVAL' "x" 2>&1) && fail "CR in key accepted"
grep -q 'must not contain newlines' <<<"$out" || fail "CR in key rejected for an unrelated reason: $out"
out=$(env_set K3 $'x\ry' 2>&1) && fail "CR in value accepted"
grep -q 'must not contain newlines' <<<"$out" || fail "CR in value rejected for an unrelated reason: $out"
cmp -s before-cr.env .env || fail ".env modified by a rejected CR call"
ls .env.tmp.* >/dev/null 2>&1 && fail "rejected CR call left temp residue"
# CRLF line endings in .env are normalized to LF (even untouched lines) - pin it.
printf 'A=1\r\nB=2\r\n' > .env
ok A "1"
printf 'A=1\nB=2\n' | cmp -s - .env || fail "CRLF in .env not normalized to LF"
rm -f .env
out=$(env_set LOST "v" 2>&1) && fail "missing .env accepted silently"
grep -q 'env_set:' <<<"$out" || fail "missing .env failed for an unrelated reason: $out"
[[ ! -e .env ]] || fail "missing .env created by env_set"
pass "special values + CR rejection + missing .env"

# 4. A stale temp file from another process is never read into .env
#    (env_set only ever rewrites its own pid-suffixed temp file).
printf 'FOO=1\n' > .env   # 3b removed .env; 4 needs a fresh one
chmod 644 .env
printf 'JUNK=stale\n' > ".env.tmp.999999"
chmod 644 ".env.tmp.999999"
ok FOO "2"
grep -Fqx 'FOO=2' .env || fail "env_set did not write"
grep -q 'JUNK' .env && fail "stale temp content leaked into .env"
grep -Fqx 'JUNK=stale' ".env.tmp.999999" || fail "env_set modified another process's temp file"
rm -f ".env.tmp.999999"
pass "stale temp isolation"

echo "all env_set tests passed"

# ── ts_status parser (extracted from init.sh, tested standalone) ─────────────
# Pull the node program out of the ts_status() helper and run sample
# `tailscale status --json` payloads through it.
TS_PROG="$(awk '/^    ts_status\(\) \{/{f=1} f && /node -e /{p=1; next} p && /^      . 2>\/dev\/null \|\| true$/{found=1; exit} p{print} END{exit found?0:1}' "$ROOT/init.sh")" || fail "ts_status extraction truncated (no end marker)"
# here-string, not a pipe: grep -q + pipefail would SIGPIPE a long TS_PROG.
grep -q 'BackendState' <<<"$TS_PROG" || fail "could not extract ts_status parser from init.sh"

# Keep node's stderr visible: a truncated extraction surfaces as a SyntaxError,
# not as a silent empty-output failure (set -e would kill the script undiagnosed).
run_ts() { printf '%s' "$1" | node -e "$TS_PROG" || fail "ts_status node failed for payload [$1]"; }

out=$(run_ts '{"BackendState":"Running","Self":{"DNSName":"nexus.x.ts.net."}}')
[[ "$out" == "Running nexus.x.ts.net" ]] || fail "ts_status: trailing dot not stripped (got: $out)"

out=$(run_ts '{"BackendState":"Running","Self":{}}')
[[ "$out" == "Running " ]] || fail "ts_status: Running without DNS (got: $out)"

out=$(run_ts '{"BackendState":"NeedsLogin"}')
[[ "$out" == "NeedsLogin " ]] || fail "ts_status: NeedsLogin state lost (got: $out)"

out=$(run_ts 'garbage')
[[ "$out" == "Unknown " ]] || fail "ts_status: malformed JSON not handled (got: $out)"

out=$(run_ts '{"BackendState":"Running","Self":{"DNSName":""}}')
[[ "$out" == "Running " ]] || fail "ts_status: empty DNSName mishandled (got: $out)"

out=$(run_ts '{"BackendState":"NeedsLogin","Self":{"DNSName":"x.ts.net."}}')
[[ "$out" == "NeedsLogin " ]] || fail "ts_status: non-Running DNS leaked (got: $out)"

out=$(run_ts '')
[[ "$out" == "Unknown " ]] || fail "ts_status: empty stdin not handled (got: $out)"

out=$(run_ts '{"Self":{}}')
[[ "$out" == "Unknown " ]] || fail "ts_status: missing BackendState not defaulted (got: $out)"

pass "ts_status parser (8 payloads)"

echo "all ts_status tests passed"
