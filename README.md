# Mintlayer Web GUI

A Docker Compose stack that runs a full Mintlayer node, a headless wallet, and an Astro-based web interface for wallet management.

## Architecture

```
Browser → Astro web GUI (port 4321)
              │  server-side proxy — credentials never reach the browser
              ▼
        wallet-rpc-daemon  :3034 (internal)
              │  JSON-RPC 2.0
              ▼
         node-daemon  :3030 (internal)
              │  P2P
              ▼
        Mintlayer network

Optional (--profile indexer):
  node-daemon → api-blockchain-scanner-daemon → postgres → api-web-server :3000
              ▲
        web-gui reads the REST API to power Token Management and Trading pages
```

> **Without the indexer:** the Token Management and Trading pages are hidden. All other features (balance, send, receive, staking, address management) work without it.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) with the Compose plugin (v2) or `docker-compose` (v1)

---

## Running

### Recommended — interactive setup

```bash
./init.sh
```

The script walks you through every option (network, wallet, passwords, ports, indexer, Pinata JWT), writes `.env`, and starts the stack. That's all you need for a first run.

---

### Using Make

A `Makefile` wraps the most common Docker Compose commands:

| Target | What it does |
|---|---|
| `make up` | Start all services |
| `make down` | Stop and remove all containers (all profiles + orphans) |
| `make restart-gui` | Rebuild and restart only the web-gui container |
| `make build` | Rebuild all images without starting |
| `make logs` | Tail logs for all services |
| `make dev` | Start web-gui in dev mode with HMR (node + wallet use prod images) |
| `make dev-indexer` | Dev mode + full indexer stack |
| `make dev-build` | Rebuild the dev image (run after adding npm packages) |
| `make wallet-cli` | Open an interactive wallet-cli session |

---

### Manual setup

**1. Copy and edit the environment file**

```bash
cp .env.example .env
```

Open `.env` and set at minimum:

| Variable | What to change |
|---|---|
| `NETWORK` | `mainnet` or `testnet` |
| `NODE_RPC_PASSWORD` | anything strong |
| `WALLET_RPC_PASSWORD` | anything strong |

**2. Create the data directory**

```bash
mkdir -p mintlayer-data
```

Node chain data and wallet files are stored here. Inside containers it maps to `/home/mintlayer/`.

**3. Start the stack**

```bash
docker compose up -d
```

Services started:

| Container | What it does |
|---|---|
| `node-daemon` | Syncs the Mintlayer blockchain (takes hours on first run) |
| `wallet-rpc-daemon` | Headless wallet — starts with no wallet loaded |
| `web-gui` | Web interface at <http://localhost:4321> |

**4. Create your wallet**

Open <http://localhost:4321/setup> and use the **Create new wallet** form.

- Use `/home/mintlayer/my_wallet` as the path — it appears as `./mintlayer-data/my_wallet` on the host
- Write down the mnemonic shown — it will not be displayed again

**5. Make the wallet load automatically on restart**

```bash
# .env
WALLET_FILE=my_wallet
```

```bash
docker compose restart wallet-rpc-daemon
```

The dashboard at <http://localhost:4321> will now show your balance and sync status.

> **Sync time:** balance and transaction history only appear once the node has fully synced. On first run this takes several hours for mainnet. The dashboard shows the current block height so you can track progress.

---

## Optional: indexer stack

The indexer adds a PostgreSQL database, a blockchain scanner, and a REST API for querying blocks, transactions, and addresses.

```bash
docker compose --profile indexer up -d
```

The REST API is available at <http://localhost:3000> (configurable via `API_WEB_SERVER_PORT` in `.env`).

---

## Useful commands

```bash
# Start everything
make up                        # or: docker compose up -d

# Stop everything
make down                      # or: docker compose --profile indexer down --remove-orphans

# Watch logs
docker compose logs -f
docker compose logs -f wallet-rpc-daemon

# Interactive wallet CLI (connects to the running daemon)
make wallet-cli                # or: docker compose --profile wallet_cli run --rm wallet-cli

# Restart after changing .env
docker compose restart

# Pull latest images
docker compose pull && docker compose up -d
```

---

## Web GUI pages

| Page | URL | Description |
|---|---|---|
| Dashboard | `/` | Balance, sync status, staking state |
| Balances | `/balances` | Detailed balance breakdown |
| Management | `/management` | Wallet management overview |
| → Addresses | `/management/addresses` | List and generate receive addresses |
| → Transactions | `/management/transactions` | Transaction history |
| → UTXOs | `/management/utxos` | UTXO list |
| → Wallet | `/management/wallet` | Wallet settings and info |
| Send | `/send` | Send ML to an address |
| Staking | `/staking` | Staking status and instructions |
| Token Management | `/token-management` | Issue and manage tokens — **requires indexer** |
| Trading | `/trading` | DEX trading — **requires indexer** |
| Wallet setup | `/setup` | Create or open a wallet |

> **Token Management** and **Trading** are hidden when `INDEXER_ENABLED=false` in `.env`.

---

## Development

Run the Astro app locally against a running daemon:

```bash
cd app
npm install

export WALLET_RPC_URL=http://localhost:3034
export WALLET_RPC_USERNAME=wallet_user
export WALLET_RPC_PASSWORD=your_password

npm run dev
# → http://localhost:4321
```

To expose the wallet RPC port to the host, uncomment the `ports` block for `wallet-rpc-daemon` in `docker-compose.yml`.

---

## Security

- Run `./init.sh` or set strong passwords in `.env` before exposing this to any network.
- Wallet RPC credentials are never sent to the browser — all calls are proxied server-side by the Astro app.
- Only a fixed allowlist of RPC methods is callable through the `/api/rpc` endpoint.
- The wallet RPC (3034) and node RPC (3030) ports are not exposed to the host by default.
