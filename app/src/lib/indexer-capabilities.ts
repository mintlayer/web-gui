/**
 * Indexer capability probe - server-side only.
 *
 * The optional indexer profile (api-web-server) gained its 1.4.1 surface
 * (mempool REST endpoints, /v2/stream SSE, keyset pagination, holders, order
 * book). Installations that have not pulled the new daemon images yet still
 * run a pre-1.4.1 api-web-server, so every 1.4.1-only feature must check
 * capabilities first and degrade gracefully.
 *
 * The probe result is cached briefly so pages can call it per request without
 * hammering the indexer. Detection is per endpoint: a 404 means the feature is
 * absent, a 200 means present (same release ships both endpoints, but they are
 * checked independently so partial deployments are handled honestly).
 */

const INDEXER_URL = process.env.INDEXER_URL ?? 'http://api-web-server:3000';

const CAPABILITIES_TTL_MS = 60_000;

export interface IndexerCapabilities {
  /** GET /v2/mempool/transactions + mempool fallback on /v2/transaction/{id}. */
  mempoolApi: boolean;
  /** GET /v2/stream server-sent events (tx_seen, block, reorg). */
  stream: boolean;
}

let cache: { capabilities: IndexerCapabilities; expiresAt: number } | null = null;

/**
 * HEAD would be cheaper but SSE endpoints may not advertise it; a GET that is
 * aborted as soon as the response headers arrive only costs one HTTP round
 * trip and no event delivery.
 */
async function probeEndpoint(path: string): Promise<boolean> {
  try {
    const res = await fetch(`${INDEXER_URL}/api/v2${path}`, {
      headers: { accept: 'text/event-stream' },
      signal: AbortSignal.timeout(5_000),
    });
    // Release the connection immediately - we only care about the status.
    res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Returns which 1.4.1 endpoints the connected indexer supports. Results are
 * cached for 60 seconds; pass force=true to re-probe immediately.
 */
export async function getIndexerCapabilities(force = false): Promise<IndexerCapabilities> {
  if (!force && cache && cache.expiresAt > Date.now()) {
    return cache.capabilities;
  }
  const [mempoolApi, stream] = await Promise.all([
    probeEndpoint('/mempool/transactions'),
    probeEndpoint('/stream'),
  ]);
  const capabilities: IndexerCapabilities = { mempoolApi, stream };
  cache = { capabilities, expiresAt: Date.now() + CAPABILITIES_TTL_MS };
  return capabilities;
}

/** Test hook: forget the cached probe result. */
export function resetCapabilitiesCacheForTests(): void {
  cache = null;
}
