# ── Build stage ────────────────────────────────────────────────────────────────
FROM rust:1-slim AS builder

WORKDIR /build
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*

COPY Cargo.toml ./
COPY src ./src
RUN cargo build --release

# ── Runtime stage ──────────────────────────────────────────────────────────────
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libsqlite3-0 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 1000 --create-home wallet

COPY --from=builder /build/target/release/bdk-wallet /usr/local/bin/bdk-wallet

USER wallet
ENV DATA_DIR=/data \
    BIND_ADDR=0.0.0.0:8080
VOLUME /data
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/bdk-wallet"]
