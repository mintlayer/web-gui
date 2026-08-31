# syntax=docker/dockerfile:1

# ── Build stage — runs natively on the CI host (no QEMU) ─────────────────────
# $BUILDPLATFORM is always the host arch (e.g. linux/amd64).
# TypeScript/Astro compilation is pure JS so this is safe.
FROM --platform=$BUILDPLATFORM node:22-alpine AS builder

RUN apk add --no-cache python3 make g++ sqlite-dev

WORKDIR /app

COPY package.json package-lock.json ./
COPY wasm-wrappers/ ./wasm-wrappers/
RUN npm ci && npm rebuild better-sqlite3

COPY . .
RUN npm run build

# ── Prod deps — still on the BUILD platform, but targeting the right arch ─────
# npm_config_arch tells node-pre-gyp to download / compile the native addon
# for the TARGET architecture instead of the host architecture.
FROM --platform=$BUILDPLATFORM node:22-alpine AS prod-deps
ARG TARGETARCH

RUN apk add --no-cache python3 make g++ sqlite-dev

WORKDIR /app
COPY package.json package-lock.json ./

# Map Docker arch names (amd64/arm64) to npm arch names (x64/arm64)
RUN NPM_ARCH=$([ "$TARGETARCH" = "amd64" ] && echo "x64" || echo "$TARGETARCH") && \
    npm_config_arch=$NPM_ARCH npm ci --omit=dev

# ── Production image ──────────────────────────────────────────────────────────
FROM node:22-alpine AS runner

# Run as an unprivileged user (S-M4): never root over wallet data.
# uid/gid 10001 is used by the image; docker-compose overrides user: with
# ML_USER_ID/ML_GROUP_ID so the process matches the host-mounted data dirs
# (they only need the image files to be world-readable, which they are).
RUN addgroup -g 10001 app && adduser -u 10001 -G app -D -H -s /sbin/nologin app

WORKDIR /app

COPY --from=builder --chown=app:app /app/dist           ./dist
COPY --from=builder --chown=app:app /app/wasm-wrappers  ./wasm-wrappers
COPY --from=builder --chown=app:app /app/package.json   ./package.json
COPY --from=builder --chown=app:app /app/scripts        ./scripts
COPY --from=prod-deps --chown=app:app /app/node_modules ./node_modules

ENV HOST=0.0.0.0
ENV PORT=4321
EXPOSE 4321

USER app

CMD ["node", "dist/server/entry.mjs"]
