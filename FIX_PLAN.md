# Review Fix Plan — Security & Code Review Findings

Sources: security review (0 Critical / 1 High / 5 Medium / 6 Low) and code review
(1 Blocker / 6 Major / 11 Minor), 2026-08-31. Overlapping findings merged.

Order: severity high → low. Each item lists files and the concrete fix.
Verification at the bottom. Check off items as they land.

---

## Phase 1 — Blocker (user-facing correctness)

- [x] **B1. Encrypted wallet → infinite reload loop; password modal never renders**
  - `app/src/pages/index.astro:44, 93, 242, 306–308`
  - `needsPassword` is declared but never assigned server-side. After
    `/api/wallet-open` returns `needs_password`, the client reloads, the server
    still renders the "Opening wallet…" screen, and the loop repeats forever.
  - Fix: in the balance-fetch catch block, detect the password-needed state
    (probe via `ensureWalletOpen()` / inspect `wallet_info` error) and set
    `needsPassword = true` so the modal renders.
  - Add a regression test for the `needs_password` render path.

## Phase 2 — High (security)

- [x] **H-1. Plugin install = session cookie → RCE, no step-up auth**
  - `app/src/pages/api/plugins/install.ts`, `app/src/lib/plugins.ts:109–188, 213–232`,
    `app/src/pages/plugins/[plugin]/[...path].astro:97`
  - Any session holder can POST a `.tgz` whose code is `import()`ed in-process
    with full FS/network/wallet-RPC access. Inconsistent with the app's own
    threat model (seed reveal / MCP spend require fresh TOTP).
  - Fix (incremental):
    1. Require a valid current TOTP code on install/uninstall — reuse the
       pattern from `api/settings/reset-2fa.ts` / `api/settings/mcp-settings.ts`.
    2. Stop rendering plugin HTML raw via `set:html`; escape it or render in a
       sandboxed iframe (`sandbox` without `allow-same-origin`).
    3. (Later — deferred, as planned) signed plugin packages: ed25519 signature in `plugin.json`
       verified against a pinned key; separate origin for plugin serving.

## Phase 3 — Major

- [x] **M1. Rate limiting keyed on spoofable `x-forwarded-for`; unbounded maps**
  - `app/src/pages/login.astro:41–44`, `app/src/pages/api/rpc.ts:7–8`,
    `app/src/lib/auth.ts:199, 224`, `app/src/lib/passkey.ts:49–69`
  - Direct exposure (no proxy) means the header is client-controlled: rotates
    past the 5-attempt login lockout; `loginAttempts`/`rpcAttempts` never
    pruned (memory exhaustion). Note `pendingChallenges` *does* prune.
  - Fix: prefer `Astro.clientAddress`; trust XFF only when a `TRUST_PROXY=true`
    env is set. Prune expired entries on each check (mirror `createChallenge`).
    Align `rpc.ts` fallback with `login.astro` (`clientAddress`, not `'unknown'`).
- [x] **M2. `tsc --noEmit` fails (19 errors); CI never typechecks**
  - `app/src/lib/plugins.test.ts:215–294` (`readdirSync` mock typed as
    `string[]` vs `Dirent[]`), `app/src/pages/api/plugins/[id]/toggle.test.ts:25,38`,
    `uninstall.test.ts:17` (invalid `as APIContext` casts).
  - Fix: type the mock as `Dirent[]` (`mockReturnValue(... as unknown as Dirent[])`),
    build test contexts via a typed helper, add `astro check` (after
    `astro sync`) or `tsc --noEmit` to the CI test job.
- [x] **M3. `/api/block-stream` verifies tokens against hardcoded version 0**
  - `app/src/pages/api/block-stream.ts:18` (also 22–24)
  - Pre-password-change tokens stay valid here after revocation (and valid v1
    tokens are wrongly rejected, silently breaking the live feed).
  - Fix (one line): pass `getPref<number>('auth.session_version') ?? 0` to
    `verifySessionToken`. Also: lines 22–24 duplicate env/URL logic from
    `wallet-rpc.ts` with a *different* fallback — move URL construction into
    `wallet-rpc.ts` exports and reuse.
- [x] **M4. Seed import deletes wallet file before recovery succeeds**
  - `app/src/pages/management/wallet.astro:122–128`
  - `unlink` happens before `recoverWallet` (which can run "many minutes");
    a crash/timeout mid-scan destroys the wallet.
  - Fix: recover to a temp path first, then swap atomically:
    `recoverWallet(path + '.recover')` → close → `unlink` → `rename` → `openWallet`.
- [x] **M5. `rpcCall` has no fetch timeout; unguarded JSON parsing**
  - `app/src/lib/wallet-rpc.ts:71–78, 93`
  - Hung daemon blocks API routes/SSR indefinitely; non-JSON 200 body throws a
    raw `SyntaxError` instead of `WalletRpcError`. Inconsistently,
    `telegram.ts:82` already uses `AbortSignal.timeout`.
  - Fix: add `signal: AbortSignal.timeout(30_000)` (longer/opt-out for
    `recoverWallet`); wrap `res.json()` in try/catch → `WalletRpcError`.
    Also add timeout to `sendTelegramMessage`/`sendTelegramPhoto`.
- [x] **M6. Password-change logic duplicated**
  - `app/src/pages/management/settings.astro:24–43` vs `app/src/pages/api/settings/password.ts:16–41`
  - Fix: extract `resolvePasswordChange({...})` into `src/lib/` with unit tests
    (pattern: `resolveMcpSettings`); both paths call it.

## Phase 4 — Medium (security)

- [x] **S-M1. No Content-Security-Policy**
  - `app/src/middleware.ts:20–25`
  - Add CSP in `applySecurityHeaders`, roll out report-only first:
    `default-src 'self'; img-src 'self' https: data:; script-src 'self' 'nonce-…';
    style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none';
    base-uri 'none'; form-action 'self'`. Needs nonces/hashes for Astro inline
    scripts and care for the plugin iframe.
- [x] **S-M2. `javascript:` URI in `href` from chain-controlled metadata**
  - `app/src/components/TokenManagePanel.tsx:354, 478`
  - `info.metadata_uri.text` rendered directly as `<a href>`; React does not
    sanitize the URL scheme.
  - Fix: shared helper — render as link only when `new URL(uri)` parses with
    `https:`/`ipfs:` (map `ipfs://` → gateway); otherwise plain text. Reuse the
    helper wherever chain-supplied URIs are rendered.
- [x] **S-M4. web-gui container runs as root over wallet data**
  - `app/Dockerfile` (no `USER`), `docker-compose.yml`
  - Fix: runner stage — `addgroup/adduser` (uid/gid 10001), `chown /app`,
    `USER app`; keep mounted-dir ownership compatible with `ML_USER_ID`.
- [x] **S-M5. GUI binds to all interfaces by default**
  - `docker-compose.yml`, `docker-compose.dev.yml`, `deploy/docker-compose.yml`
  - Fix: default `127.0.0.1:${WEB_GUI_PORT:-4321}:4321`; `init.sh` asks
    "expose to network?" and opts in explicitly. (Also consider the
    unauthenticated `api-web-server:3000` indexer port.)

## Phase 5 — Low / Minor hardening batch (one PR)

- [x] **L1. `/api/ipfs-upload` has no upload size limit** (`app/src/pages/api/ipfs-upload.ts:35–38`)
  — reject `file.size > N` early; enforce `Content-Length` ceiling (50 MB cap
  already used by plugin install / setup — match it).
- [x] **L2. Unbounded fan-out in `/api/address-tokens`** (`:33–56`)
  — cap `addresses.length` (≤ 200), batch token-info enrichment.
- [x] **L3. PBKDF2 iterations below OWASP guidance** (`app/src/lib/auth.ts:49`,
  `init.sh`, `tools/reset-password.sh`)
  — 100k → ≥210k; keep format-parsing so old hashes verify, rehash-on-login.
- [x] **L4. Seed phrase in POST-response HTML without `no-store`**
  (`app/src/pages/setup.astro:62–65, 127–134`, `management/wallet.astro:79–88, 222–269`)
  — set `Cache-Control: no-store` on responses containing seed material.
- [x] **L5. Images pulled as `:latest` + auto-update** (`docker-compose.yml`,
  `deploy/linux.sh`)
  — pin by digest (`image@sha256:…`), keep Watchtower opt-in.
  → LANDED as `ML_*_IMAGE` env overrides (digest-pinnable) + documented path;
  Watchtower remains profile-gated (opt-in). Actual digests must be resolved
  from the registry at release time.
- [x] **Minor: FormData coercion** (`settings.astro:46, 63, 78–80, 96, 103–104`)
  — route every field through the existing `str()` helper.
- [x] **Minor: N+1 token-info RPC** (`index.astro:62–64`)
  — single `getTokensInfo(tokenIds)` call instead of per-token `map`.
- [x] **Minor: plugin `entry` path traversal** (`app/src/lib/plugins.ts:164–166, 221`)
  — reject entries containing `..` or leading `/`.
- [x] **Minor: txWatcher duplicate EventSources** (`app/src/lib/txWatcher.ts:39–42`)
  — `es.close()` before nulling on error (or don't null; rely on native
  reconnection).
- [x] **Minor: `prefs-db.ts` robustness** (`:21, 25`)
  — try/catch around `JSON.parse`; add `deletePref` instead of writing
  `"null"` rows (`setPref(key, null)` used by `uninstallPlugin`).
- [x] **Minor: stale session cookie after version bump** (`app/src/middleware.ts:52–59`)
  — comment or skip rolling refresh when the version changed mid-request.
- [x] **Minor: dead route** — remove `/api/login` from `PUBLIC_PATHS`
  (`app/src/middleware.ts:14`).
- [x] **Minor: `isValidRpId` all-hex hostname false positive** (`app/src/lib/passkey.ts:81`)
  — require `:` or `[` before applying the IPv6 charset check.
- [x] **Minor: MCP `send_coins` amount cap** (`app/scripts/mcp-server.mjs:249`)
  — optional per-tx cap pref to limit blast radius of a hijacked AI client.

## Phase 6 — Nits (optional, batch anytime)

- [x] `escHtml` escape `'` (`addresses.astro:238–244`).
- [x] SSE heartbeat for `/api/block-stream` (low impact; EventSource reconnects).
- [x] `wallet.astro:76` — coerce `form.get('action')` instead of `as string`.
- [x] `astro.config.mjs:11` — fix "ponytail" comment / remove stray TODO note.
- [ ] `settings.astro:143–147` — render stored secrets with a
      `type="password"` reveal pattern.
      (Inputs are already `type="password"`; a JS reveal toggle remains optional.)
- [x] `npm audit fix` — clear dev-only `nanoid` high finding (via `postcss`
      ← `autoprefixer`), not shipped to production.
- [x] Docs: note that LAN plain-HTTP hostnames fail login due to `Secure`
      cookie (localhost exemption only) — availability footgun.

---

## Verification

1. `npm run build` and `tsc --noEmit` (or `astro check`) pass in `app/`.
2. Full test suite green (448 tests; coverage thresholds 80% lines / 75%
   branches) — add tests for: B1 render path, TOTP-gated plugin install,
   rate-limit pruning/proxy handling, password-change shared helper,
   recover-then-swap import, `rpcCall` timeout/JSON error, metadata-URI
   sanitizer.
3. Manual: open an encrypted wallet → password modal renders (B1); change
   password → old SSE token rejected / new works (M3); install plugin without
   TOTP → rejected (H-1).
4. Manual: `docker compose up` → GUI reachable only on 127.0.0.1 (S-M5);
   container process runs as non-root (`docker compose exec web-gui id`) (S-M4).
