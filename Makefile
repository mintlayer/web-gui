.PHONY: up down restart nuke restart-gui build logs dev dev-build dev-local wallet-cli bitcoin bitcoin-cli nft-images-public pending-transactions list-utxos

ACCOUNT ?= 0

## Start all services
up:
	docker compose up -d

## Stop and remove all containers (including optional profiles and orphaned run containers)
down:
	docker compose --profile indexer --profile wallet_cli --profile bitcoin down --remove-orphans

## Full clean restart: tear down everything, fix stuck networks, then bring up fresh
## Fixes "Network still in use" / "network not found" errors from dangling containers.
restart: down
	@# Disconnect any containers still clinging to the project network
	@NETWORK=mintlayer-web-gui_default; \
	CONTAINERS=$$(docker network inspect $$NETWORK --format '{{range .Containers}}{{.Name}} {{end}}' 2>/dev/null || true); \
	if [ -n "$$CONTAINERS" ]; then \
		echo "Disconnecting dangling containers from $$NETWORK: $$CONTAINERS"; \
		for c in $$CONTAINERS; do docker network disconnect -f $$NETWORK $$c 2>/dev/null || true; done; \
	fi
	@# Remove the network if it still exists so Docker recreates it cleanly
	@docker network rm mintlayer-web-gui_default 2>/dev/null || true
	docker compose up -d

## Nuclear option: remove ALL stopped containers and unused networks project-wide,
## then restart. Use when restart still fails.
nuke:
	docker compose --profile indexer --profile wallet_cli --profile bitcoin down --remove-orphans --volumes 2>/dev/null || true
	docker container prune -f
	docker network prune -f
	docker compose up -d

## Rebuild and restart only the web-gui container
restart-gui:
	docker compose up -d --build web-gui

## Rebuild all images without starting
build:
	docker compose build

## Tail logs for all services (Ctrl+C to stop)
logs:
	docker compose logs -f

## Start all services in dev mode with HMR (rebuilds web-gui image, includes indexer stack)
## Tears down existing containers first so you always start clean.
dev:
	docker compose --profile indexer -f docker-compose.yml -f docker-compose.dev.yml down --remove-orphans 2>/dev/null || true
	docker compose --profile indexer -f docker-compose.yml -f docker-compose.dev.yml up --build

## Like dev, but uses locally-built core images (run ./build-core-images.sh first)
dev-local:
	docker compose --profile indexer -f docker-compose.yml -f docker-compose.dev.yml up

## Rebuild dev image only (run after adding npm packages, then re-run make dev)
dev-build:
	docker compose --profile indexer -f docker-compose.yml -f docker-compose.dev.yml build web-gui

## Open an interactive wallet-cli session connected to the running wallet-rpc-daemon
wallet-cli:
	docker compose --profile wallet_cli run --rm wallet-cli

## Start the optional Bitcoin stack (bitcoind + BTC wallet sidecar) alongside core services
bitcoin:
	docker compose --profile bitcoin up -d
	@echo "Bitcoin node + BTC wallet started. First sync can take a long time on mainnet."
	@echo "Open the Bitcoin page in the web UI to create your BTC wallet."

## bitcoin-cli shell inside the Bitcoin node container
## Usage: make bitcoin-cli CMD='getblockchaininfo'
bitcoin-cli:
	docker compose --profile bitcoin exec bitcoind bitcoin-cli -rpcuser=$$(grep '^BITCOIN_RPC_USERNAME=' .env | cut -d= -f2) -rpcpassword=$$(grep '^BITCOIN_RPC_PASSWORD=' .env | cut -d= -f2) $(CMD)

## List pending transactions for account ACCOUNT (default 0) via wallet RPC.
## Usage: make pending-transactions  or  make pending-transactions ACCOUNT=1
pending-transactions:
	docker run --rm \
		--network web-gui_default \
		-v "$(CURDIR)/tools:/tools:ro" \
		-v "$(CURDIR)/.env:/.env:ro" \
		-e WALLET_RPC_HOST=wallet-rpc-daemon \
		alpine sh -c 'apk add -q bash curl jq >/dev/null && bash /tools/list-pending-transactions.sh $(ACCOUNT)'

## List UTXOs for account ACCOUNT (default 0) via wallet RPC.
## Usage: make list-utxos  or  make list-utxos ACCOUNT=1
list-utxos:
	docker run --rm \
		--network web-gui_default \
		-v "$(CURDIR)/tools:/tools:ro" \
		-v "$(CURDIR)/.env:/.env:ro" \
		-e WALLET_RPC_HOST=wallet-rpc-daemon \
		alpine sh -c 'apk add -q bash curl jq >/dev/null && bash /tools/list-utxos.sh $(ACCOUNT)'

## Ensure all NFT images stored on Pinata are publicly accessible.
## Runs inside Docker so it can reach wallet-rpc-daemon on the internal network.
nft-images-public:
	docker run --rm \
		--network mintlayer-web-gui_default \
		-v "$(CURDIR)/tools:/tools:ro" \
		-v "$(CURDIR)/.env:/.env:ro" \
		-e WALLET_RPC_URL=http://wallet-rpc-daemon:3034 \
		node:lts-alpine \
		node /tools/make-nft-images-public.mjs
