use anyhow::{anyhow, bail, Context, Result};
use axum::{
    extract::State,
    http::{header, HeaderMap},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use bdk::blockchain::rpc::{Auth, RpcBlockchain, RpcConfig, RpcSyncParams};
use bdk::blockchain::{Blockchain, ConfigurableBlockchain};
use bdk::database::any::SqliteDbConfiguration;
use bdk::database::{AnyDatabase, AnyDatabaseConfig, ConfigurableDatabase, Database};
use bdk::wallet::AddressIndex;
use bdk::{FeeRate, SignOptions, SyncOptions, TransactionDetails, Wallet};
use bdk::bitcoin::{bip32::ExtendedPrivKey, Address, Network};
use bip39::{Language, Mnemonic};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    fs,
    path::PathBuf,
    str::FromStr,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tokio::{sync::Mutex as AsyncMutex, task::spawn_blocking};
use tracing::{error, info, warn};

// ── Configuration (env) ────────────────────────────────────────────────────────

struct Config {
    network: Network,
    data_dir: PathBuf,
    rpc_url: String,
    rpc_user: String,
    rpc_pass: String,
    http_user: String,
    http_pass: String,
}

impl Config {
    fn from_env() -> Result<Self> {
        // Whitelist exactly the four Bitcoin networks: a typo ("Testnet",
        // "test-net") must not silently become a MAINNET wallet that derives
        // mainnet keys and can spend real coins.
        let network = match std::env::var("BITCOIN_NETWORK").unwrap_or_default().as_str() {
            "" | "mainnet" => Network::Bitcoin,
            "testnet" => Network::Testnet,
            "regtest" => Network::Regtest,
            "signet" => Network::Signet,
            other => {
                // Fail closed: a typo must not silently become a MAINNET
                // wallet. Key-holding misconfigurations abort the start.
                return Err(anyhow::anyhow!(
                    "BITCOIN_NETWORK='{other}' is not one of mainnet|testnet|regtest|signet"
                ));
            }
        };
        Ok(Self {
            network,
            data_dir: PathBuf::from(std::env::var("DATA_DIR").unwrap_or_else(|_| "/data".into())),
            rpc_url: require_env("BITCOIN_RPC_URL")?,
            rpc_user: require_env("BITCOIN_RPC_USERNAME")?,
            rpc_pass: require_env("BITCOIN_RPC_PASSWORD")?,
            http_user: require_env("WALLET_HTTP_USERNAME")?,
            http_pass: require_env("WALLET_HTTP_PASSWORD")?,
        })
    }

    /// bitcoind connection config for the BDK rpc backend.
    ///
    /// `start_time` bounds how far back the node scans for the imported
    /// watch-only descriptors: for a fresh wallet we use the wallet's creation
    /// time (persisted in seed.json) so the first sync does not walk the whole
    /// chain. Subsequent syncs continue from the node's own recorded sync time.
    fn rpc_config(&self, sync_start_time: u64) -> RpcConfig {
        RpcConfig {
            url: self.rpc_url.clone(),
            auth: Auth::UserPass {
                username: self.rpc_user.clone(),
                password: self.rpc_pass.clone(),
            },
            network: self.network,
            wallet_name: WALLET_NAME.to_string(),
            sync_params: Some(RpcSyncParams {
                start_time: sync_start_time,
                // Matches INITIAL_SCRIPT_CACHE below: the initial importdescriptors
                // batch must stay small, because the jsonrpc client enforces a hard
                // 15s request timeout and a large import triggers a rescan that
                // exceeds it (sync would then never complete).
                start_script_count: INITIAL_SCRIPT_CACHE,
                ..Default::default()
            }),
        }
    }
}

fn require_env(name: &str) -> Result<String> {
    std::env::var(name)
        .ok()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| anyhow!("missing required env var {name}"))
}

// ── State ──────────────────────────────────────────────────────────────────────

type BdkWallet = Wallet<AnyDatabase>;

/// The wallet bitcoind loads for this sidecar. Wallet-scoped RPC calls
/// (getwalletinfo for the rescan probe) must target /wallet/<name>: on the
/// bare endpoint bitcoind only answers when exactly one wallet is loaded,
/// so the scan-retry probe would silently no-op on any other setup.
const WALLET_NAME: &str = "bdk-sidecar";

/// Error marker for "a wallet sync holds the lock": the send endpoint maps
/// it to the same 503 the read endpoints return, instead of parking the
/// request (and still broadcasting after the client timed out).
const SYNC_BUSY: &str = "wallet sync in progress";

/// True when a sync horizon may be scanned on a pruned node. `cutoff` is
/// the unix time of the oldest block bitcoind still serves (its prune
/// window start); a horizon at or after that can never miss coins. With 24h
/// of slack, a wallet created right now always passes, while restores aimed
/// inside the pruned range are refused. `cutoff` unknown (stats RPC
/// unavailable): only a just-created wallet is considered safe.
fn horizon_safe_on_pruned(horizon: u64, cutoff: Option<i64>, now: u64) -> bool {
    if horizon == 0 {
        return false;
    }
    let cutoff = cutoff.map(|t| t.max(0) as u64).unwrap_or(now);
    horizon.saturating_add(24 * 3600) >= cutoff
}

/// How many addresses per keychain to derive and cache up front. Keep this
/// small - see the comment on `start_script_count` in `Config::rpc_config`.
const INITIAL_SCRIPT_CACHE: usize = 20;

struct AppState {
    config: Arc<Config>,
    wallet: AsyncMutex<Option<BdkWallet>>,
    /// Wallet creation unix time - sync horizon for freshly created wallets.
    sync_start_time: Mutex<u64>,
    /// Unix time of the last SUCCESSFUL sync. After the first sync bdk
    /// rescans from this point (its recorded db sync time), not from the
    /// creation horizon - the pruned-mode guard must use the same origin or
    /// a healthy wallet freezes once it ages out of the prune window.
    last_sync_time: Mutex<Option<u64>>,
    syncing: AtomicBool,
    /// Why the persisted wallet is NOT loaded (network mismatch, corrupt db,
    /// unreadable seed). Surfaced via /status so the UI shows the actual
    /// cause instead of offering the dead "Try Sync" remedy (a sync can
    /// never load a wallet - only create/link can).
    load_error: Mutex<Option<String>>,
    /// Human-readable failure from the most recent sync attempt (cleared on
    /// success). Surfaced via /status so a silently-refused or failing scan
    /// is visible to the client instead of a permanent 0.00 balance.
    last_sync_error: Mutex<Option<String>>,
    node: reqwest::Client,
}

impl AppState {
    fn seed_path(&self) -> PathBuf {
        self.config.data_dir.join("seed.json")
    }
}

// ── Seed persistence ───────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
struct SeedFile {
    mnemonic: String,
    network: String,
    created_at: u64,
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn save_seed(path: &PathBuf, mnemonic: &str, network: Network, created_at: u64) -> Result<()> {
    let file = SeedFile {
        mnemonic: mnemonic.to_string(),
        network: network_name(network).to_string(),
        created_at,
    };
    // create_new + 0600 from the start: no window where the mnemonic sits on
    // disk with default (world-readable) permissions before the chmod lands.
    // sync_all before returning: the only copy of the wallet's key material
    // must not sit in a page cache that a crash/power-loss can lose - a seed
    // file that exists but reads back empty truncates the wallet into
    // unrecoverable.
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)?;
        f.write_all(serde_json::to_string_pretty(&file)?.as_bytes())?;
        f.sync_all()?;
    }
    #[cfg(not(unix))]
    fs::write(path, serde_json::to_string_pretty(&file)?)?;
    Ok(())
}

fn network_name(n: Network) -> &'static str {
    match n {
        Network::Bitcoin => "mainnet",
        Network::Testnet => "testnet",
        Network::Regtest => "regtest",
        Network::Signet => "signet",
        _ => "unknown",
    }
}

// ── Wallet construction ────────────────────────────────────────────────────────

/// Open (or create) the wallet database for the given mnemonic.
fn build_wallet(config: &Config, mnemonic: &str) -> Result<BdkWallet> {
    let m = Mnemonic::parse_in(Language::English, mnemonic).context("invalid mnemonic")?;
    let seed = m.to_seed_normalized("");
    let xprv = ExtendedPrivKey::new_master(config.network, &seed)?;

    // BIP84: account 0, coin type 0' on mainnet / 1' on test networks
    let coin = if config.network == Network::Bitcoin { "0" } else { "1" };
    let external = format!("wpkh({xprv}/84'/{coin}'/0'/0/*)");
    let internal = format!("wpkh({xprv}/84'/{coin}'/0'/1/*)");

    let database = AnyDatabase::from_config(&AnyDatabaseConfig::Sqlite(SqliteDbConfiguration {
        path: config.data_dir.join("wallet.sqlite").display().to_string(),
    }))?;

    // The sqlite db (plus its WAL/SHM sidecars) holds the full xprv - tighten
    // to owner-only. bdk creates the file with the process umask, which in
    // typical container images leaves it 0644 (world-readable).
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perm = fs::Permissions::from_mode(0o600);
        let db_path = config.data_dir.join("wallet.sqlite");
        let _ = fs::set_permissions(&db_path, perm.clone());
        for sidecar in ["wallet.sqlite-wal", "wallet.sqlite-shm"] {
            let p = config.data_dir.join(sidecar);
            if p.exists() {
                let _ = fs::set_permissions(&p, perm.clone());
            }
        }
    }

    let wallet = Wallet::new(&external, Some(&internal), config.network, database)
        .context("failed to open wallet")?;

    // The rpc backend refuses to sync until enough scriptPubKeys are cached
    // (start_script_count). Pre-derive them; a no-op on existing DBs.
    for index in 0..INITIAL_SCRIPT_CACHE as u32 {
        wallet
            .get_address(AddressIndex::Peek(index))
            .context("deriving initial addresses")?;
    }

    Ok(wallet)
}

fn generate_mnemonic() -> Result<String> {
    let entropy: [u8; 16] = rand::random();
    Ok(Mnemonic::from_entropy_in(Language::English, &entropy)?.to_string())
}

// ── bitcoind JSON-RPC helpers ──────────────────────────────────────────────────

async fn node_rpc(
    state: &AppState,
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value> {
    post_rpc(state, &state.config.rpc_url, method, params).await
}

/// Same as `node_rpc` but scoped to this sidecar's wallet. Calls like
/// getwalletinfo only answer on /wallet/<name> when bitcoind serves more
/// than one wallet (or none).
async fn node_wallet_rpc(
    state: &AppState,
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value> {
    let url = format!(
        "{}/wallet/{}",
        state.config.rpc_url.trim_end_matches('/'),
        WALLET_NAME
    );
    post_rpc(state, &url, method, params).await
}

async fn post_rpc(
    state: &AppState,
    url: &str,
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value> {
    let res = state
        .node
        .post(url)
        .basic_auth(&state.config.rpc_user, Some(&state.config.rpc_pass))
        .json(&json!({ "jsonrpc": "1.0", "id": "bdk", "method": method, "params": params }))
        .send()
        .await
        .context("bitcoind unreachable")?;
    let body: serde_json::Value = res.json().await.context("bad JSON-RPC response")?;
    if let Some(err) = body.get("error") {
        if !err.is_null() {
            bail!("bitcoind RPC error: {err}");
        }
    }
    Ok(body.get("result").cloned().unwrap_or(serde_json::Value::Null))
}

// ── BTC decimal parsing (string -> sats, no floats) ────────────────────────────

fn parse_btc_to_sats(amount: &str) -> Result<u64> {
    let trimmed = amount.trim();
    if trimmed.is_empty() || !trimmed.chars().all(|c| c.is_ascii_digit() || c == '.') {
        bail!("amount must contain only digits and a decimal point");
    }
    // Reject multi-dot inputs BEFORE splitting: '.' in the fraction would
    // underflow the digit math below (panic in debug, silent wrap in release).
    if trimmed.matches('.').count() > 1 {
        bail!("amount must contain at most one decimal point");
    }
    let (whole, frac) = match trimmed.split_once('.') {
        None => (trimmed, ""),
        Some((w, f)) => (w, f),
    };
    if !frac.chars().all(|c| c.is_ascii_digit()) {
        bail!("amount must contain only digits and a decimal point");
    }
    if frac.len() > 8 {
        bail!("amount supports at most 8 decimal places");
    }
    let whole: u64 = if whole.is_empty() {
        0
    } else {
        whole.parse().context("bad integer part")?
    };
    let mut sats: u64 = whole.checked_mul(100_000_000).context("amount overflow")?;
    let mut scale = 10_000_000u64; // first fractional digit is worth 1e7 sats
    for c in frac.chars() {
        let digit = c.to_digit(10).context("invalid fractional digit")? as u64;
        sats = sats.checked_add(digit * scale).context("amount overflow")?;
        scale /= 10;
    }
    Ok(sats)
}

// ── Auth middleware ────────────────────────────────────────────────────────────

/// Constant-time byte comparison (length difference still leaks - acceptable).
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

async fn auth_middleware(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    request: axum::extract::Request,
    next: Next,
) -> Response {
    if request.uri().path() == "/health" {
        return next.run(request).await;
    }
    let ok = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Basic "))
        .and_then(|b64| {
            use base64::Engine;
            base64::engine::general_purpose::STANDARD
                .decode(b64)
                .ok()
                .and_then(|raw| String::from_utf8(raw).ok())
        })
        .map(|creds| {
            creds
                .split_once(':')
                .map(|(u, p)| {
                    ct_eq(u.as_bytes(), state.config.http_user.as_bytes())
                        && ct_eq(p.as_bytes(), state.config.http_pass.as_bytes())
                })
                .unwrap_or(false)
        })
        .unwrap_or(false);
    if ok {
        next.run(request).await
    } else {
        (axum::http::StatusCode::UNAUTHORIZED, "unauthorized").into_response()
    }
}

// ── Response helpers ───────────────────────────────────────────────────────────

fn wallet_not_created() -> Response {
    (
        axum::http::StatusCode::CONFLICT,
        Json(json!({ "ok": false, "error": "wallet not created yet - POST /wallet first" })),
    )
        .into_response()
}

/// Map a balance to its JSON shape (shared by /status and /balance).
fn balance_json(b: &bdk::Balance) -> serde_json::Value {
    json!({
        "confirmed": b.confirmed.to_string(),
        "trustedPending": b.trusted_pending.to_string(),
        "untrustedPending": b.untrusted_pending.to_string(),
        "immature": b.immature.to_string(),
    })
}

/// Best-effort classification of *user-fixable* send errors. Everything else
/// is returned opaque (full detail stays in the tracing log only) so sidecar
/// internals (paths, sqlite, RPC bodies) never reach the browser.
fn classify_send_error(msg: &str) -> Option<(axum::http::StatusCode, String)> {
    let lower = msg.to_lowercase();
    if lower.contains("insufficient") || lower.contains("not enough") {
        Some((axum::http::StatusCode::BAD_REQUEST, "insufficient funds".into()))
    } else if lower.contains("dust") {
        // bdk: "Output below the dust limit: N" - a user-fixable amount
        // problem, not an internal error.
        Some((
            axum::http::StatusCode::BAD_REQUEST,
            "amount is below the dust limit - send a larger amount".into(),
        ))
    } else if lower.contains("signing failed") || lower.contains("could not finalize") {
        Some((axum::http::StatusCode::BAD_REQUEST, "transaction signing failed".into()))
    } else if lower.contains("wallet not created yet") {
        Some((axum::http::StatusCode::CONFLICT, "wallet not created yet - POST /wallet first".into()))
    } else if lower.contains("unreachable")
        || lower.contains("connection refused")
        || lower.contains("connection closed")
        || lower.contains("timed out")
        || lower.contains("timeout")
        || lower.contains("lookup address information")
        || lower.contains("name resolution")
        || lower.contains("name or service not known")
    {
        // jsonrpc/reqwest transport failures while talking to bitcoind: a
        // start-the-node state the UI already knows about, not an internal
        // error - and the TOTP code the user just typed should not be burned
        // on a condition it cannot fix. Checked BEFORE the broadcast arm so
        // "broadcast failed: connection refused" reads as a node problem.
        // The DNS substrings cover a STOPPED container (docker's embedded
        // DNS stops answering for it), the most common down presentation.
        Some((
            axum::http::StatusCode::BAD_GATEWAY,
            "bitcoin node is unreachable - start the bitcoin stack and retry".into(),
        ))
    } else if lower.contains("broadcast") || lower.contains("bitcoind rpc error") {
        Some((axum::http::StatusCode::BAD_GATEWAY, "bitcoin node refused the transaction".into()))
    } else if lower.contains("fee rate") || lower.contains("feerate") {
        Some((axum::http::StatusCode::BAD_REQUEST, "invalid fee rate".into()))
    } else {
        None
    }
}

fn internal_error(e: anyhow::Error) -> Response {
    error!("{e:#}");
    if let Some((status, msg)) = classify_send_error(&e.to_string()) {
        return (status, Json(json!({ "ok": false, "error": msg }))).into_response();
    }
    (
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "ok": false, "error": "internal error (see sidecar logs)" })),
    )
        .into_response()
}

// ── Handlers ───────────────────────────────────────────────────────────────────

/// Load the wallet in a blocking task and store it in the shared state.
async fn open_wallet(state: &Arc<AppState>, mnemonic: &str, created_at: u64) -> Result<()> {    let config = Arc::clone(&state.config);
    let mnemonic = mnemonic.to_string();
    let loaded = spawn_blocking(move || {
        let wallet = build_wallet(&config, &mnemonic)?;
        // Seed the in-memory horizon from bdk's own PERSISTED sync record
        // (wallet.sqlite's SyncTime, written at the end of every sync). The
        // prune guard must evaluate the same origin bdk scans from - which
        // across a restart is the db record, not the seed's created_at.
        // Without this, a healthy wallet whose created_at aged past the
        // prune window is refused forever on a pruned node: the refusal
        // precedes any sync, so the in-memory time could never advance.
        let db_sync_time = wallet
            .database()
            .get_sync_time()
            .ok()
            .flatten()
            .map(|st| st.block_time.timestamp);
        Ok::<(BdkWallet, Option<u64>), anyhow::Error>((wallet, db_sync_time))
    })
    .await
    .map_err(|e| anyhow!("join error: {e}"))??;
    let (wallet, db_sync_time) = loaded;
    *state.sync_start_time.lock().unwrap_or_else(|p| p.into_inner()) = created_at;
    // A different wallet invalidates the previous one's sync-time knowledge;
    // a persisted bdk sync record supersedes it (see above).
    *state.last_sync_time.lock().unwrap_or_else(|p| p.into_inner()) = db_sync_time;
    *state.wallet.lock().await = Some(wallet);
    Ok(())
}

#[derive(Deserialize)]
struct CreateWalletReq {
    /// Optional BIP39 mnemonic to restore. Generated when absent.
    seed: Option<String>,
    /// Sync horizon override (unix secs). Restores default to 0 - a full
    /// scan - because addresses derived from an existing seed may hold
    /// UTXOs from before the wallet was created. Freshly generated seeds
    /// use "now" and callers may narrow a restore with an explicit value.
    scan_from: Option<u64>,
}

/// POST /wallet - create the wallet from an optional seed.
/// Returns the mnemonic ONLY on creation - it is never served again.
async fn create_wallet(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CreateWalletReq>,
) -> Response {
    if state.seed_path().exists() {
        return (
            axum::http::StatusCode::CONFLICT,
            Json(json!({ "ok": false, "error": "wallet already exists" })),
        )
            .into_response();
    }

    let mnemonic = match req.seed {
        Some(ref s) => {
            let normalized = s.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase();
            if let Err(e) = Mnemonic::parse_in(Language::English, &normalized) {
                return (
                    axum::http::StatusCode::BAD_REQUEST,
                    Json(json!({ "ok": false, "error": format!("invalid seed: {e}") })),
                )
                    .into_response();
            }
            normalized
        }
        None => match generate_mnemonic() {
            Ok(m) => m,
            Err(e) => return internal_error(e.context("mnemonic generation")),
        },
    };

    // Freshly generated seeds have no history - sync from now. Restores
    // (including linking an existing Mintlayer seed) must see every block:
    // addresses derived from the same words may hold old UTXOs, so the
    // horizon defaults to 0 (full scan) unless the caller narrows it.
    let created_at = if req.seed.is_none() {
        now_unix()
    } else {
        req.scan_from.unwrap_or(0)
    };

    // A pruned node cannot serve blocks below its prune window, so a
    // full-history restore would silently miss coins. Refuse instead.
    if created_at == 0 {
        match node_rpc(&state, "getblockchaininfo", json!([])).await {
            Ok(info) => {
                if info.get("pruned").and_then(|b| b.as_bool()).unwrap_or(false) {
                    return (
                        axum::http::StatusCode::CONFLICT,
                        Json(json!({
                            "ok": false,
                            "error": "This Bitcoin node keeps only recent blocks (pruned mode), so it cannot scan the full history an old seed may need. Switch to a full node (BITCOIN_PRUNE=0, BITCOIN_TXINDEX=1, then resync) before restoring this seed.",
                        })),
                    )
                        .into_response();
                }
            }
            Err(_) => {
                // Fail closed: an unreachable node makes the prune state
                // UNKNOWABLE. Committing a full-history restore here would
                // freeze it permanently once a pruned node returns (the
                // sync-time guard refuses every scan, so last_sync_time
                // could never advance past created_at = 0). Generated
                // wallets (created_at = now) keep the lenient path because
                // they are horizon-safe by construction.
                return (
                    axum::http::StatusCode::SERVICE_UNAVAILABLE,
                    Json(json!({
                        "ok": false,
                        "error": "Cannot verify the node's prune status - the bitcoin node is unreachable. Start the bitcoin stack and retry the restore.",
                    })),
                )
                    .into_response();
            }
        }
    }

    if let Err(e) = save_seed(&state.seed_path(), &mnemonic, state.config.network, created_at) {
        // A failed write can leave a truncated seed.json behind; without
        // this cleanup every retry 409s on "wallet already exists" and the
        // wallet is unrecoverable through the API (shell-only fix).
        let _ = tokio::fs::remove_file(&state.seed_path()).await;
        return internal_error(e.context("persisting seed"));
    }

    match open_wallet(&state, &mnemonic, created_at).await {
        Ok(()) => {
            // Scan immediately: a restore that reads 0.00 until the user
            // finds the sync button looks exactly like "your coins are
            // gone". Fire-and-forget - the /status endpoint reports progress.
            spawn_sync(&state);
            // Echo the mnemonic ONLY when we generated it. For restores the
            // user already knows their seed - never serve it back.
            let mut body = json!({
                "ok": true,
                "created": true,
                "network": network_name(state.config.network),
            });
            if req.seed.is_none() {
                body["mnemonic"] = json!(mnemonic);
            }
            Json(body).into_response()
        }
        Err(e) => {
            // The seed file now exists but the wallet is unusable (sqlite
            // open/write error, disk full): every later POST /wallet would
            // 409 "already exists" and a generated mnemonic is lost. Remove
            // the failed wallet files so the user can simply retry.
            let seed_path = state.seed_path();
            if let Err(cleanup) = fs::remove_file(&seed_path) {
                error!(
                    "wallet open failed ({e:#}) and removing the failed seed file {} failed: {cleanup:#}",
                    seed_path.display()
                );
            }
            let _ = fs::remove_file(state.config.data_dir.join("wallet.sqlite"));
            // Sqlite keeps write-ahead log / journal sidecars next to the db;
            // a stale one could be replayed into the retried wallet's fresh
            // database and resurrect rows from the failed attempt.
            let _ = fs::remove_file(state.config.data_dir.join("wallet.sqlite-wal"));
            let _ = fs::remove_file(state.config.data_dir.join("wallet.sqlite-shm"));
            let _ = fs::remove_file(state.config.data_dir.join("wallet.sqlite-journal"));
            internal_error(anyhow!(
                "wallet file could not be opened after creation ({e:#}); the failed wallet files were removed so you can retry"
            ))
        }
    }
}

/// After a failed sync, check whether bitcoind is still rescanning the
/// wallet (a restore/link seeds importdescriptors with an old timestamp,
/// and Core scans in the background for a long time). While it is, every
/// immediate retry would hit the RPC read timeout again - re-arm the sync
/// so restores converge without the user nudging POST /sync. Stops as soon
/// as Core reports the scan finished and a retry still fails.
async fn schedule_scan_retry(st: Arc<AppState>) {
    // Wallet-scoped on purpose: getwalletinfo on the bare endpoint only
    // answers when bitcoind has exactly one wallet loaded.
    let scanning = node_wallet_rpc(&st, "getwalletinfo", json!([]))
        .await
        .ok()
        .and_then(|v| v.get("scanning").cloned())
        .map(|s| s.is_object() || s.as_bool().unwrap_or(false))
        .unwrap_or(false);
    if !scanning {
        return;
    }
    info!("bitcoind is rescanning the wallet - retrying sync in 30s");
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        spawn_sync(&st);
    });
}

/// Kick off a background sync unless one is already running. Returns false
/// when a sync is in flight. Shared by POST /sync, wallet creation and boot
/// so no entry point leaves the wallet stale at 0.00.
fn spawn_sync(state: &Arc<AppState>) -> bool {
    if state.syncing.swap(true, Ordering::SeqCst) {
        return false;
    }
    let st = Arc::clone(state);
    tokio::spawn(async move {
        // bdk's next scan starts from the last recorded sync time once one
        // exists (only a FIRST sync still uses the creation horizon), so the
        // prune guard evaluates the same origin bdk will actually scan from.
        let horizon = st
            .last_sync_time
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .unwrap_or(*st.sync_start_time.lock().unwrap_or_else(|p| p.into_inner()));
        // A scan horizon older than the node's prune window would silently
        // miss coins: refuse instead (covers full-history restores AND
        // narrowed horizons that still fall inside the pruned range).
        let mut refused = false;
        if let Ok(info) = node_rpc(&st, "getblockchaininfo", json!([])).await {
            let pruned = info.get("pruned").and_then(|b| b.as_bool()).unwrap_or(false);
            let prune_height = info.get("pruneheight").and_then(|b| b.as_u64()).unwrap_or(0);
            if pruned {
                // bitcoind's pruneheight is a BLOCK HEIGHT while the horizon
                // is a unix timestamp - comparing them directly is always
                // false and silently disabled the guard. Convert the prune
                // window to time via getblockstats so restores aimed inside
                // the pruned range are actually refused.
                let cutoff = node_rpc(&st, "getblockstats", json!([prune_height, ["time"]]))
                    .await
                    .ok()
                    .and_then(|v| v.get("time").and_then(|t| t.as_i64()));
                if !horizon_safe_on_pruned(horizon, cutoff, now_unix()) {
                    error!(
                        "wallet sync horizon {horizon} reaches inside the prune window (pruneheight {prune_height}) - sync refused; switch to a full node (BITCOIN_PRUNE=0, BITCOIN_TXINDEX=1) and resync"
                    );
                    *st.last_sync_error.lock().unwrap_or_else(|p| p.into_inner()) =
                        Some(format!(
                            "sync refused: the node is pruned to block {prune_height}, newer than this wallet's sync horizon"
                        ));
                    refused = true;
                }
            }
        }
        if !refused {
            let sb = Arc::clone(&st);
            let res = spawn_blocking(move || -> Result<()> {
                let start_time = *sb.sync_start_time.lock().unwrap_or_else(|p| p.into_inner());
                let chain = RpcBlockchain::from_config(&sb.config.rpc_config(start_time))?;
                let mut guard = sb.wallet.blocking_lock();
                match guard.as_mut() {
                    Some(w) => w.sync(&chain, SyncOptions::default())?,
                    // Lost a race with a failed load after the route-level
                    // check: fail loudly instead of reporting success (a
                    // success would clear last_sync_error and fake progress).
                    None => return Err(anyhow!("no wallet loaded")),
                }
                Ok(())
            })
            .await;
            match res {
                Ok(Ok(())) => {
                    info!("wallet sync complete");
                    *st.last_sync_error.lock().unwrap_or_else(|p| p.into_inner()) = None;
                    // Advance the prune-guard horizon: the NEXT scan starts
                    // from here (bdk's recorded sync time), not from the
                    // creation horizon, so a wallet kept in sync never ages
                    // out of the prune window.
                    *st.last_sync_time.lock().unwrap_or_else(|p| p.into_inner()) = Some(now_unix());
                }
                Ok(Err(e)) => {
                    warn!("wallet sync failed: {e:#}");
                    *st.last_sync_error.lock().unwrap_or_else(|p| p.into_inner()) =
                        Some(format!("last sync failed: {e}"));
                    schedule_scan_retry(Arc::clone(&st)).await;
                }
                Err(e) => {
                    warn!("sync task join error: {e}");
                    *st.last_sync_error.lock().unwrap_or_else(|p| p.into_inner()) =
                        Some(format!("last sync failed: {e}"));
                    schedule_scan_retry(Arc::clone(&st)).await;
                }
            }
        }
        st.syncing.store(false, Ordering::SeqCst);
    });
    true
}

/// POST /sync - sync the wallet against bitcoind (no-op while one runs).
async fn sync(State(state): State<Arc<AppState>>) -> Response {
    // A sync can never LOAD a wallet - only create/link/open can - so with
    // no wallet loaded this is a knowable failure, not a success: 409 keeps
    // the UI from recommending a dead remedy and leaves last_sync_error
    // (e.g. the boot load failure) intact.
    if state.wallet.lock().await.is_none() {
        return (
            axum::http::StatusCode::CONFLICT,
            Json(json!({ "ok": false, "error": "no wallet loaded" })),
        )
            .into_response();
    }
    let started = spawn_sync(&state);
    Json(json!({ "ok": true, "syncStarted": started })).into_response()
}

/// GET /status - node + wallet overview for the Settings page.
async fn status(State(state): State<Arc<AppState>>) -> Response {
    let chain = node_rpc(&state, "getblockchaininfo", json!([])).await;
    let node_json = chain_node_json(chain.as_ref().ok());

    let wallet_exists = state.seed_path().exists();
    let syncing = state.syncing.load(Ordering::SeqCst);
    let last_sync_error = state
        .last_sync_error
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone();
    // A scan holds the wallet mutex for the whole background rescan, which
    // can run for hours on a restore. Never make the polling client wait on
    // it: answer from the scan state instead (the wallet must be loaded for
    // a sync to be running at all), so status chips keep updating.
    let (wallet_loaded, balance) = match state.wallet.try_lock() {
        Ok(wallet) => match wallet.as_ref() {
            Some(w) => match w.get_balance() {
                Ok(b) => (true, Some(balance_json(&b))),
                Err(e) => {
                    warn!("get_balance failed: {e}");
                    (true, None)
                }
            },
            None => (false, None),
        },
        Err(_) => (true, None),
    };
    let load_error = state
        .load_error
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone();

    Json(json!({
        "ok": true,
        "network": network_name(state.config.network),
        "walletExists": wallet_exists,
        "walletLoaded": wallet_loaded,
        "node": node_json,
        "balance": balance,
        "syncing": syncing,
        "lastSyncError": last_sync_error,
        "loadError": load_error,
    }))
    .into_response()
}

/// The `node` object of /status: reachability + sync progress + whether the
/// node is pruned (which decides if full-history seed restores are possible).
fn chain_node_json(chain: Option<&serde_json::Value>) -> serde_json::Value {
    let (reachable, blocks, headers, ibd, pruned, prune_height, txindex) = match chain {
        Some(info) => (
            true,
            info.get("blocks").and_then(|b| b.as_u64()).unwrap_or(0),
            info.get("headers").and_then(|b| b.as_u64()).unwrap_or(0),
            info.get("initialblockdownload").and_then(|b| b.as_bool()).unwrap_or(false),
            info.get("pruned").and_then(|b| b.as_bool()).unwrap_or(false),
            info.get("pruneheight").and_then(|b| b.as_u64()),
            info.get("txindex").and_then(|b| b.as_bool()),
        ),
        None => (false, 0, 0, false, false, None, None),
    };
    json!({
        "reachable": reachable,
        "blocks": blocks,
        "headers": headers,
        "synced": reachable && !ibd && blocks == headers,
        "initialBlockDownload": ibd,
        "pruned": pruned,
        "pruneHeight": prune_height,
        "txindex": txindex,
    })
}

/// GET /balance - totals in satoshis (strings).
async fn balance(State(state): State<Arc<AppState>>) -> Response {
    // Contended (a scan owns the wallet): fail fast instead of pinning the
    // caller until its client timeout - the UI keeps polling and shows the
    // scanning state until the lock frees up.
    let Ok(wallet) = state.wallet.try_lock() else {
        return sync_busy_response();
    };
    let Some(w) = wallet.as_ref() else {
        return wallet_not_created();
    };
    match w.get_balance() {
        Ok(b) => {
            let mut body = balance_json(&b);
            body["ok"] = json!(true);
            body["total"] = json!((b.confirmed + b.trusted_pending + b.untrusted_pending).to_string());
            Json(body).into_response()
        }
        Err(e) => internal_error(e.into()),
    }
}

/// POST /address/new - derive a fresh receive address.
async fn new_address(State(state): State<Arc<AppState>>) -> Response {
    // Same contention rule as /balance: during a scan the overview route
    // still polls this endpoint, and parking here stalls every page load
    // for the full client timeout even though only the lock is busy.
    let Ok(mut wallet) = state.wallet.try_lock() else {
        return sync_busy_response();
    };
    match wallet.as_mut() {
        Some(w) => match w.get_address(AddressIndex::New) {
            Ok(info) => Json(json!({ "ok": true, "address": info.address.to_string() })).into_response(),
            Err(e) => internal_error(e.into()),
        },
        None => wallet_not_created(),
    }
}

/// GET /address/current - last unused address (for the Receive view).
async fn current_address(State(state): State<Arc<AppState>>) -> Response {
    let Ok(mut wallet) = state.wallet.try_lock() else {
        return sync_busy_response();
    };
    match wallet.as_mut() {
        Some(w) => match w.get_address(AddressIndex::LastUnused) {
            Ok(info) => Json(json!({ "ok": true, "address": info.address.to_string() })).into_response(),
            Err(e) => internal_error(e.into()),
        },
        None => wallet_not_created(),
    }
}

/// GET /txs?limit=50 - wallet transaction history, newest first.
#[derive(Deserialize)]
struct TxsQuery {
    limit: Option<usize>,
}

async fn txs(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(q): axum::extract::Query<TxsQuery>,
) -> Response {
    let Ok(wallet) = state.wallet.try_lock() else {
        return sync_busy_response();
    };
    let Some(w) = wallet.as_ref() else {
        return wallet_not_created();
    };
    let limit = q.limit.unwrap_or(50).min(500);
    let tx_list = w.list_transactions(false).unwrap_or_default();
    let mut list: Vec<&TransactionDetails> = tx_list.iter().collect();
    list.sort_by_key(|t| {
        std::cmp::Reverse(t.confirmation_time.as_ref().map(|c| c.height).unwrap_or(u32::MAX))
    });
    let txs: Vec<serde_json::Value> = list
        .into_iter()
        .take(limit)
        .map(|t| {
            json!({
                "txid": t.txid.to_string(),
                "received": t.received.to_string(),
                "sent": t.sent.to_string(),
                "fee": t.fee.map(|f| f.to_string()),
                "confirmed": t.confirmation_time.is_some(),
                "height": t.confirmation_time.as_ref().map(|c| c.height),
                "timestamp": t.confirmation_time.as_ref().map(|c| c.timestamp),
            })
        })
        .collect();
    Json(json!({ "ok": true, "transactions": txs })).into_response()
}

#[derive(Deserialize)]
struct SendReq {
    address: String,
    /// BTC amount as a decimal string (max 8 decimals) - never a float.
    amount_btc: String,
    /// Optional fee rate in sat/vB.
    fee_rate_sat_vb: Option<f32>,
}

/// POST /send - build, sign and broadcast a transaction.
async fn send(State(state): State<Arc<AppState>>, Json(req): Json<SendReq>) -> Response {
    let address = match Address::from_str(&req.address) {
        Ok(a) => a,
        Err(_) => {
            return (
                axum::http::StatusCode::BAD_REQUEST,
                Json(json!({ "ok": false, "error": "invalid bitcoin address" })),
            )
                .into_response()
        }
    };
    if !address.is_valid_for_network(state.config.network) {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": format!(
                "address is not valid for {}",
                network_name(state.config.network)
            ) })),
        )
            .into_response();
    }

    let sats = match parse_btc_to_sats(&req.amount_btc) {
        Ok(s) => s,
        Err(e) => {
            return (
                axum::http::StatusCode::BAD_REQUEST,
                Json(json!({ "ok": false, "error": e.to_string() })),
            )
                .into_response()
        }
    };
    if sats == 0 {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": "amount must be greater than zero" })),
        )
            .into_response();
    }

    let st = Arc::clone(&state);
    let res = spawn_blocking(move || -> Result<String> {
        let start_time = *st.sync_start_time.lock().unwrap_or_else(|p| p.into_inner());
        let chain = RpcBlockchain::from_config(&st.config.rpc_config(start_time))?;
        // Never park behind a scan: a request that parks here outlives the
        // client's 60s timeout, the user sees "may or may not have been
        // broadcast" and a retry then queues a SECOND spend behind the same
        // lock - the textbook path to paying twice. Fail fast with the same
        // 503 the read endpoints use; the UI disables the form while a scan
        // runs so this is rarely surfaced raw.
        let mut guard = st.wallet.try_lock().map_err(|_| anyhow!(SYNC_BUSY))?;
        let Some(w) = guard.as_mut() else {
            bail!("wallet not created yet - POST /wallet first");
        };
        let mut builder = w.build_tx();
        builder.add_recipient(address.payload.script_pubkey(), sats);
        if let Some(rate) = req.fee_rate_sat_vb {
            builder.fee_rate(FeeRate::from_sat_per_vb(rate));
        }
        let (mut psbt, _details) = builder.finish()?;
        let finalized = w
            .sign(&mut psbt, SignOptions::default())
            .context("signing failed")?;
        if !finalized {
            bail!("could not finalize transaction");
        }
        let tx = psbt.extract_tx();
        let txid = tx.txid().to_string();
        chain.broadcast(&tx)?;
        Ok(txid)
    })
    .await;

    match res {
        Ok(Ok(txid)) => {
            // Mark the spent outputs in the background: doing the catch-up
            // inline after broadcast can exceed the client timeout and make
            // an already-broadcast transaction look failed. The UI refreshes
            // on its own; a failed or skipped sync only leaves the balance
            // stale until the next one.
            spawn_sync(&state);
            Json(json!({ "ok": true, "txid": txid })).into_response()
        }
        Ok(Err(e)) if e.to_string().contains(SYNC_BUSY) => sync_busy_response(),
        Ok(Err(e)) => internal_error(e),
        Err(e) => internal_error(anyhow!("join error: {e}")),
    }
}

/// GET /fee-estimate - smart fee estimates (sat/vB) for common targets.
async fn fee_estimate(State(state): State<Arc<AppState>>) -> Response {
    let mut estimates = serde_json::Map::new();
    for target in [1u64, 3, 6, 12, 25] {
        match node_rpc(&state, "estimatesmartfee", json!([target])).await {
            Ok(v) => {
                // btc/kB -> sat/vB = btc * 1e8 / 1000
                if let Some(btc_per_kb) = v.get("feerate").and_then(|f| f.as_f64()) {
                    // estimatesmartfee answers -1 when it lacks data (fresh
                    // or restarting node): the ceil conversion saturates to
                    // 0 sat/vB, which the UI would present as a real
                    // estimate. Skip instead.
                    if btc_per_kb > 0.0 {
                        estimates.insert(
                            target.to_string(),
                            json!((btc_per_kb * 100_000_000f64 / 1000f64).ceil() as u64),
                        );
                    }
                }
            }
            Err(e) => warn!("estimatesmartfee({target}) failed: {e:#}"),
        }
    }
    Json(json!({ "ok": true, "satPerVb": estimates })).into_response()
}

async fn health() -> &'static str {
    "ok"
}

/// 503 used by read endpoints when a wallet sync holds the lock: callers
/// poll again shortly; nothing is wrong with the node itself.
fn sync_busy_response() -> Response {
    (
        axum::http::StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({ "ok": false, "error": "wallet sync in progress - try again shortly", "syncing": true })),
    )
        .into_response()
}

// ── Main ───────────────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    let config = Arc::new(Config::from_env()?);
    info!(
        "starting bdk-wallet sidecar (network: {})",
        network_name(config.network)
    );

    fs::create_dir_all(&config.data_dir)?;

    let state = Arc::new(AppState {
        config,
        wallet: AsyncMutex::new(None),
        sync_start_time: Mutex::new(now_unix()),
        last_sync_time: Mutex::new(None),
        syncing: AtomicBool::new(false),
        load_error: Mutex::new(None),
        last_sync_error: Mutex::new(None),
        // Bounded timeouts on the bitcoind client: without them a hung/rpc-
        // wedged node pins sync/send handlers until the HTTP client gives up
        // (which, with no timeout, is never).
        node: reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(5))
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .context("failed to build bitcoind HTTP client")?,
    });

    // Auto-load the wallet if a seed was previously persisted.
    match fs::read_to_string(state.seed_path()) {
        Ok(raw) => match serde_json::from_str::<SeedFile>(&raw) {
            Ok(file) => {
                if file.network != network_name(state.config.network) {
                    // seed.json records the network it was created on: opening
                    // the same seed under another network would silently
                    // re-derive the other coin path (84'/1'/... vs 84'/0'/...)
                    // over the same address cache - a wallet that shows 0.00
                    // forever. Refuse to load and say how to recover.
                    error!(
                        "seed.json was created for network '{}' but BITCOIN_NETWORK is '{}' - not loading; restore the previous network or delete the bitcoin-wallet-data dir to start over",
                        file.network,
                        network_name(state.config.network)
                    );
                    *state
                        .load_error
                        .lock()
                        .unwrap_or_else(|p| p.into_inner()) = Some(format!(
                        "seed.json was created for network '{}' but BITCOIN_NETWORK is '{}' - switch back or delete the bitcoin-wallet-data dir to start over",
                        file.network,
                        network_name(state.config.network)
                    ));
                } else {
                    match open_wallet(&state, &file.mnemonic, file.created_at).await {
                        Ok(()) => {
                            info!("wallet loaded from persisted seed");
                            *state.load_error.lock().unwrap_or_else(|p| p.into_inner()) = None;
                            // Boot-time scan so balances and history are current
                            // without manual action after a restart.
                            spawn_sync(&state);
                        }
                        Err(e) => {
                            error!("failed to load persisted wallet: {e:#}");
                            *state.load_error.lock().unwrap_or_else(|p| p.into_inner()) =
                                Some(format!("persisted wallet failed to load: {e:#}"));
                        }
                    }
                }
            }
            Err(e) => {
                error!("seed file unreadable: {e}");
                *state.load_error.lock().unwrap_or_else(|p| p.into_inner()) =
                    Some(format!("seed file unreadable: {e}"));
            }
        },
        Err(_) => info!("no seed found - POST /wallet to create or restore"),
    }

    let app = Router::new()
        .route("/wallet", post(create_wallet))
        .route("/status", get(status))
        .route("/sync", post(sync))
        .route("/balance", get(balance))
        .route("/address/new", post(new_address))
        .route("/address/current", get(current_address))
        .route("/txs", get(txs))
        .route("/send", post(send))
        .route("/fee-estimate", get(fee_estimate))
        .route("/health", get(health))
        .layer(middleware::from_fn_with_state(Arc::clone(&state), auth_middleware))
        .with_state(state);

    let addr = std::env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".into());
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    info!("listening on {addr}");
    axum::serve(listener, app).await?;
    Ok(())
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_amounts() {
        assert_eq!(parse_btc_to_sats("1").unwrap(), 100_000_000);
        assert_eq!(parse_btc_to_sats("0.5").unwrap(), 50_000_000);
        assert_eq!(parse_btc_to_sats("0.00000001").unwrap(), 1);
        assert_eq!(parse_btc_to_sats("12.3456789").unwrap(), 1_234_567_890);
        assert_eq!(parse_btc_to_sats(" 21 ").unwrap(), 2_100_000_000);
        assert_eq!(parse_btc_to_sats(".5").unwrap(), 50_000_000);
        assert_eq!(parse_btc_to_sats("1.").unwrap(), 100_000_000);
    }

    #[test]
    fn rejects_multi_dot_amounts() {
        // used to u8-underflow to a silent 3.74 BTC misparse in release builds
        assert!(parse_btc_to_sats("1.2.3").is_err());
        assert!(parse_btc_to_sats("..").is_err());
    }

    #[test]
    fn rejects_garbage_amounts() {
        assert!(parse_btc_to_sats("").is_err());
        assert!(parse_btc_to_sats("  ").is_err());
        assert!(parse_btc_to_sats("-1").is_err());
        assert!(parse_btc_to_sats("1e3").is_err());
        assert!(parse_btc_to_sats("abc").is_err());
        assert!(parse_btc_to_sats("0.000000001").is_err()); // 9 decimals
        assert!(parse_btc_to_sats("1.2.3.4").is_err());
    }

    #[test]
    fn rejects_overflow() {
        assert!(parse_btc_to_sats("99999999999").is_err() || parse_btc_to_sats("184467440737.09551616").is_err());
        assert!(parse_btc_to_sats("18446744073709551616").is_err());
    }

    #[test]
    fn ct_eq_matches_only_equal_inputs() {
        assert!(ct_eq(b"abc", b"abc"));
        assert!(!ct_eq(b"abc", b"abd"));
        assert!(!ct_eq(b"abc", b"abcd"));
        assert!(!ct_eq(b"", b"a"));
        assert!(ct_eq(b"", b""));
    }

    #[test]
    fn send_error_classification() {
        let (s, m) = classify_send_error("InsufficientFunds { needed: .. }").unwrap();
        assert_eq!(s, axum::http::StatusCode::BAD_REQUEST);
        assert_eq!(m, "insufficient funds");
        assert_eq!(classify_send_error("NoSpaceLeft { path: \"/data/wallet.sqlite\" }"), None);
    }
}

#[cfg(test)]
mod chain_info_tests {
    use super::chain_node_json;
    use serde_json::json;

    #[test]
    fn full_node_shape() {
        let info = json!({
            "blocks": 900_000u64, "headers": 900_000u64,
            "initialblockdownload": false, "pruned": false,
            "pruneheight": serde_json::Value::Null, "txindex": true,
        });
        let node = chain_node_json(Some(&info));
        assert_eq!(node["reachable"], true);
        assert_eq!(node["synced"], true);
        assert_eq!(node["pruned"], false);
        assert_eq!(node["txindex"], true);
        assert!(node["pruneHeight"].is_null());
    }

    #[test]
    fn pruned_node_shape() {
        let info = json!({
            "blocks": 900_000u64, "headers": 900_001u64,
            "initialblockdownload": true, "pruned": true, "pruneheight": 840_000u64,
        });
        let node = chain_node_json(Some(&info));
        assert_eq!(node["pruned"], true);
        assert_eq!(node["pruneHeight"], 840_000u64);
        assert_eq!(node["synced"], false);
        assert!(node["txindex"].is_null());
    }

    #[test]
    fn unreachable_node_shape() {
        let node = chain_node_json(None);
        assert_eq!(node["reachable"], false);
        assert_eq!(node["pruned"], false);
        assert_eq!(node["synced"], false);
    }
}

#[cfg(test)]
mod prune_guard_tests {
    use super::horizon_safe_on_pruned;

    #[test]
    fn refuses_full_history_restores() {
        assert!(!horizon_safe_on_pruned(0, Some(1_799_900_000), 1_800_000_000));
    }

    #[test]
    fn accepts_wallets_created_now() {
        // created_at within the 24h slack of the prune-window start
        assert!(horizon_safe_on_pruned(1_799_950_000, Some(1_799_900_000), 1_800_000_000));
        // and when the stats RPC is unavailable the cutoff is "now"
        assert!(horizon_safe_on_pruned(1_799_990_000, None, 1_800_000_000));
    }

    #[test]
    fn refuses_restores_inside_the_pruned_range() {
        // a timestamp years old: the old `horizon < prune_height` compare
        // (1.7e9 < 8.4e5) could never fire and the guard was dead code
        assert!(!horizon_safe_on_pruned(1_000_000_000, Some(1_799_900_000), 1_800_000_000));
        // stats unavailable: conservative cutoff = now, old restore refused
        assert!(!horizon_safe_on_pruned(1_000_000_000, None, 1_800_000_000));
    }
}
