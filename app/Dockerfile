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

WORKDIR /app

COPY --from=builder    /app/dist           ./dist
COPY --from=builder    /app/wasm-wrappers  ./wasm-wrappers
COPY --from=builder    /app/package.json   ./package.json
COPY --from=builder    /app/scripts        ./scripts
COPY --from=prod-deps  /app/node_modules   ./node_modules

ENV HOST=0.0.0.0
ENV PORT=4321
EXPOSE 4321

CMD ["node", "dist/server/entry.mjs"]
