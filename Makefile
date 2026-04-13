.PHONY: up down restart nuke restart-gui build logs dev dev-build wallet-cli nft-images-public

## Start all services
up:
	docker compose up -d

## Stop and remove all containers (including optional profiles and orphaned run containers)
down:
	docker compose --profile indexer --profile wallet_cli down --remove-orphans

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
	docker compose --profile indexer --profile wallet_cli down --remove-orphans --volumes 2>/dev/null || true
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

## Rebuild dev image only (run after adding npm packages, then re-run make dev)
dev-build:
	docker compose --profile indexer -f docker-compose.yml -f docker-compose.dev.yml build web-gui

## Open an interactive wallet-cli session connected to the running wallet-rpc-daemon
wallet-cli:
	docker compose --profile wallet_cli run --rm wallet-cli

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
