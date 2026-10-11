# syntax=docker/dockerfile:1
#
# Builds the four Mintlayer daemon binaries from the mintlayer-core source
# tree (checkout provided by CI) and exports them for per-arch runtime
# image assembly.

FROM rust:bookworm AS builder

# Same build deps as the upstream mintlayer-builder image
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ca-certificates libdbus-1-dev libusb-1.0-0-dev && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY . .

RUN cargo build --release \
      -p node-daemon \
      -p wallet-rpc-daemon \
      -p api-blockchain-scanner-daemon \
      -p api-web-server

FROM scratch AS artifacts
COPY --from=builder /src/target/release/node-daemon /node-daemon
COPY --from=builder /src/target/release/wallet-rpc-daemon /wallet-rpc-daemon
COPY --from=builder /src/target/release/api-blockchain-scanner-daemon /api-blockchain-scanner-daemon
COPY --from=builder /src/target/release/api-web-server /api-web-server
