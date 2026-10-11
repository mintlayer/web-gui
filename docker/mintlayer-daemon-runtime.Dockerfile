# syntax=docker/dockerfile:1
#
# Runtime image for one Mintlayer daemon binary, mirroring the upstream
# mintlayer-runner-base + daemon Dockerfiles (bookworm-slim + gosu,
# libdbus/libusb runtime libs, ML_USER_ID-aware entrypoint).
# Build context: a directory holding entrypoint.sh and the daemon binary
# named exactly as DAEMON_NAME.

ARG DAEMON_NAME

FROM debian:bookworm-slim

ARG DAEMON_NAME

RUN apt-get update && \
    apt-get install -y --no-install-recommends gosu libdbus-1-3 libusb-1.0-0 && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /home/mintlayer

COPY entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]

COPY ${DAEMON_NAME} /usr/bin/${DAEMON_NAME}
