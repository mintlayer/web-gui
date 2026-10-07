<!--
PR size guidance: if this PR exceeds ~500 changed lines, consider splitting it
(stack or sequence). Reviews of huge diffs find fewer bugs — PR #4 (10k+ lines)
took a multi-pass review round and still shipped blockers that a small diff
review would have caught.
-->

## What & why

<!-- One paragraph: what changes, and the user-visible or operational effect. -->

## How it was tested

- [ ] `npm run test:coverage` green (or N/A: ______)
- [ ] `npx tsc --noEmit` clean
- [ ] Manual verification: ______ <!-- what you ran/clicked, on what (VM, browser) -->

## Propagation checklist

<!-- Tick or strike out — these exist because the same config lives in several places. -->

- [ ] Compose changed? → propagated to **all four** copies:
      `docker-compose.yml`, `deploy/docker-compose.yml`, embedded compose in
      `deploy/linux.sh`, embedded compose in `deploy/windows.ps1`
      (run `node tools/check-compose-sync.mjs` once the CI gate exists)
- [ ] Installer changed? → ran `deploy/linux.sh` non-interactive end-to-end
- [ ] Money-path endpoint touched? → TOTP step-up (`requireStepUp`) + rate limit + tests present
- [ ] Secrets/keys? → nothing new in `.env` format without updating `init.sh` + deploy scripts + `.env.example`

## Release notes

<!-- One line a user would care about, or "internal only". -->
