FROM node:22-alpine AS builder

RUN apk add --no-cache python3 make g++ sqlite-dev

WORKDIR /app

COPY package.json package-lock.json ./
COPY wasm-wrappers/ ./wasm-wrappers/
RUN npm ci

COPY . .
RUN npm run build

# ── Production image ──────────────────────────────────
FROM node:22-alpine AS runner

WORKDIR /app

# Copy only what's needed to run
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/wasm-wrappers ./wasm-wrappers

ENV HOST=0.0.0.0
ENV PORT=4321
EXPOSE 4321

CMD ["node", "dist/server/entry.mjs"]
