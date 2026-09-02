# btc-rpc-explorer — self-hosted Bitcoin block explorer.
#
# Built from the upstream source (janoside/btc-rpc-explorer) because no
# official Docker image is published. BTC_RPC_EXPLORER_REF pins the version;
# bump deliberately.
#
# syntax=docker/dockerfile:1
FROM node:22-alpine

ARG BTC_RPC_EXPLORER_REF=v3.5.1

RUN apk add --no-cache git

WORKDIR /app
RUN git clone --depth 1 --branch ${BTC_RPC_EXPLORER_REF} \
      https://github.com/janoside/btc-rpc-explorer.git . \
    && npm ci --omit=dev && npm cache clean --force

ENV BTCEXP_HOST=0.0.0.0 \
    BTCEXP_PORT=3002 \
    NODE_ENV=production

EXPOSE 3002
CMD ["npm", "start"]
