#!/usr/bin/env node
/**
 * make-nft-images-public.mjs
 *
 * NOTE: This script is Pinata-specific. It requires PINATA_JWT + PINATA_GATEWAY_URL.
 * For nft.storage or web3.storage users, files are always public at upload time —
 * no backfill script is needed.
 *
 * Cycles through every NFT in the wallet (account 0) and ensures their
 * icon_uri / media_uri files are publicly accessible on IPFS.
 *
 * Strategy: download each private file from the Pinata dedicated gateway,
 * then re-upload it with network:"public". Because IPFS is content-addressed
 * the CID is identical — the same URI in the NFT metadata now resolves on
 * any public gateway (ipfs.io, cloudflare-ipfs.com, etc.).
 *
 * Prerequisites:
 *   PINATA_JWT         — API key (in .env)
 *   PINATA_GATEWAY_URL — your dedicated gateway hostname, e.g. yourname.mypinata.cloud
 *                        (Pinata dashboard → Gateways, free plan includes one)
 *
 * Usage (recommended — runs inside Docker, no port exposure needed):
 *   make nft-images-public
 *
 * Direct usage (only if wallet-rpc-daemon is already reachable):
 *   WALLET_RPC_URL=http://... node tools/make-nft-images-public.mjs
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ── Config ────────────────────────────────────────────────────────────────────

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE   = path.join(SCRIPT_DIR, '..', '.env');

function loadEnv(file) {
  const vars = {};
  if (!fs.existsSync(file)) return vars;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    vars[key] = val;
  }
  return vars;
}

const env = loadEnv(ENV_FILE);

const PINATA_JWT     = process.env.PINATA_JWT         ?? env.PINATA_JWT         ?? '';
const GATEWAY_URL    = process.env.PINATA_GATEWAY_URL  ?? env.PINATA_GATEWAY_URL  ?? '';
const RPC_URL        = process.env.WALLET_RPC_URL      ?? 'http://localhost:3034';
const RPC_USER       = process.env.WALLET_RPC_USERNAME ?? env.WALLET_RPC_USERNAME ?? '';
const RPC_PASS       = process.env.WALLET_RPC_PASSWORD ?? env.WALLET_RPC_PASSWORD ?? '';

if (!PINATA_JWT) {
  console.error('Error: PINATA_JWT is not set. Add it to .env or pass it in the environment.');
  process.exit(1);
}

if (!GATEWAY_URL) {
  console.error('Error: PINATA_GATEWAY_URL is not set.');
  console.error('  1. Go to https://app.pinata.cloud/gateway');
  console.error('  2. Copy your dedicated gateway hostname, e.g.  yourname.mypinata.cloud');
  console.error('  3. Add it to .env:  PINATA_GATEWAY_URL=yourname.mypinata.cloud');
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

let _rpcId = 0;

async function walletRpc(method, params = {}) {
  const id   = ++_rpcId;
  const auth = Buffer.from(`${RPC_USER}:${RPC_PASS}`).toString('base64');
  const res  = await fetch(RPC_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  if (!res.ok) throw new Error(`Wallet RPC HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`Wallet RPC error: ${body.error.message}`);
  return body.result;
}

/** Download a CID from the dedicated Pinata gateway using the JWT as auth. */
async function downloadFromGateway(cid) {
  const url = `https://${GATEWAY_URL}/ipfs/${cid}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${PINATA_JWT}` },
  });
  if (!res.ok) throw new Error(`Gateway ${res.status} for ${cid}`);
  const buffer = await res.arrayBuffer();
  const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
  return { buffer, contentType };
}

/**
 * Re-upload a buffer to Pinata with network:"public".
 * Because IPFS is content-addressed, the returned CID will be identical to
 * the original — the same URI in NFT metadata now resolves on public gateways.
 */
async function reuploadPublic(buffer, contentType, name) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: contentType }), name);
  form.append('name', name);
  form.append('network', 'public');

  const res = await fetch('https://uploads.pinata.cloud/v3/files', {
    method:  'POST',
    headers: { Authorization: `Bearer ${PINATA_JWT}` },
    body: form,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Pinata upload ${res.status}: ${text.slice(0, 200)}`);
  const data = JSON.parse(text);
  return data.data?.cid ?? null;
}

/** Decode a { text, hex } RPC field — mirrors token-utils.ts hexToText */
function hexToText(field) {
  if (!field) return null;
  if (field.text) return field.text;
  if (!field.hex) return null;
  try { return Buffer.from(field.hex, 'hex').toString('utf8') || null; }
  catch { return null; }
}

/** Extract IPFS CID from an ipfs:// URI; null for other schemes. */
function extractCid(uri) {
  if (!uri) return null;
  if (uri.startsWith('ipfs://')) return uri.slice(7).split('/')[0];
  return null;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  console.log('=== make-nft-images-public ===\n');
  console.log(`Wallet RPC  : ${RPC_URL}`);
  console.log(`Gateway     : ${GATEWAY_URL}`);
  console.log(`Pinata JWT  : ${PINATA_JWT.slice(0, 12)}…\n`);

  // 1. Check a wallet is open
  console.log('Checking wallet status…');
  try {
    await walletRpc('wallet_best_block');
  } catch (err) {
    const msg = err.message ?? '';
    if (msg.toLowerCase().includes('no wallet') || msg.toLowerCase().includes('wallet not open')) {
      console.error('\nNo wallet is open in the daemon.');
      console.error('Open the wallet via the web UI first, then re-run:  make nft-images-public');
    } else if (msg.toLowerCase().includes('fetch') || msg.toLowerCase().includes('connect')) {
      console.error(`\nCould not reach wallet RPC at ${RPC_URL}: ${msg}`);
      console.error('Is the stack running?  make up');
    } else {
      console.error(`\nWallet RPC error: ${msg}`);
    }
    process.exit(1);
  }

  // 2. Get all tokens in balance
  console.log('Fetching wallet balance…');
  let balance;
  try {
    balance = await walletRpc('account_balance', {
      account: 0, utxo_states: ['Confirmed'], with_locked: 'Any',
    });
  } catch (err) {
    console.error(`\nFailed to fetch balance: ${err.message}`);
    process.exit(1);
  }

  const tokenIds = Object.keys(balance.tokens ?? {});
  if (tokenIds.length === 0) {
    console.log('No tokens in wallet. Nothing to do.');
    return;
  }
  console.log(`Found ${tokenIds.length} token(s) in balance. Resolving metadata…\n`);

  // 3. Resolve token info, keep only NFTs with IPFS media
  const nfts = [];
  for (const id of tokenIds) {
    let info;
    try {
      const results = await walletRpc('node_get_tokens_info', { token_ids: [id] });
      info = results[0] ?? null;
    } catch (err) {
      console.warn(`  [SKIP] ${id.slice(0, 16)}… — could not fetch info: ${err.message}`);
      continue;
    }

    if (info?.type !== 'NonFungibleToken') continue;

    const meta = info.content.metadata;
    const name = hexToText(meta.name) ?? id.slice(0, 12) + '…';
    const cids = [
      extractCid(hexToText(meta.icon_uri)),
      extractCid(hexToText(meta.media_uri)),
    ].filter(Boolean);

    if (cids.length === 0) {
      console.log(`  [SKIP] "${name}" — no IPFS URIs in metadata`);
      continue;
    }

    nfts.push({ id, name, cids: [...new Set(cids)] });
  }

  if (nfts.length === 0) {
    console.log('No NFTs with IPFS media found. Nothing to do.');
    return;
  }

  console.log(`Found ${nfts.length} NFT(s) with IPFS media.\n`);

  // 4. For each CID: download from private gateway, re-upload as public
  let totalOk = 0, totalAlready = 0, totalFail = 0;

  for (const nft of nfts) {
    console.log(`NFT: "${nft.name}" (${nft.id.slice(0, 20)}…)`);

    for (const cid of nft.cids) {
      process.stdout.write(`  CID ${cid.slice(0, 20)}… `);

      // Quick check: is it already on a public gateway?
      try {
        const probe = await fetch(`https://ipfs.io/ipfs/${cid}`, { method: 'HEAD' });
        if (probe.ok) {
          console.log('already public');
          totalAlready++;
          continue;
        }
      } catch { /* not reachable — proceed with reupload */ }

      // Download from private Pinata gateway
      let buffer, contentType;
      try {
        ({ buffer, contentType } = await downloadFromGateway(cid));
      } catch (err) {
        console.log(`FAIL (download: ${err.message})`);
        totalFail++;
        continue;
      }

      // Re-upload with network:"public" — CID will be identical
      try {
        const newCid = await reuploadPublic(buffer, contentType, nft.name);
        if (newCid && newCid !== cid) {
          // Shouldn't happen with identical content, but flag it
          console.log(`WARN — new CID differs: ${newCid}`);
        } else {
          console.log('→ re-uploaded as public ✓');
          totalOk++;
        }
      } catch (err) {
        console.log(`FAIL (reupload: ${err.message})`);
        totalFail++;
      }
    }
  }

  console.log('\n── Summary ─────────────────────────────────────────');
  console.log(`  Re-uploaded as public : ${totalOk}`);
  console.log(`  Already public        : ${totalAlready}`);
  console.log(`  Failed                : ${totalFail}`);
  if (totalFail > 0) {
    process.exitCode = 1;
  }
}

run().catch(err => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});
