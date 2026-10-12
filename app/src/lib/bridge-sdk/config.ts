/**
 * bridge-sdk — API layer for the Mintlayer bridge.
 *
 * All bridge/ml-api network access lives here. UI components never call
 * fetch directly; they consume this SDK so endpoints, URLs, and error
 * handling stay in one testable place.
 *
 * Ported from bridge-frontend/src/bridge-sdk, adapted for Astro:
 * PUBLIC_* env vars are read via import.meta.env instead of process.env.
 */

export const DEFAULT_BRIDGE_API_URL = 'https://api.bridge.mintlayer.org/api/v1/';
export const DEFAULT_MINTLAYER_API_URL =
  'https://api-server.mintlayer.org/api/v2/';

const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};

export const getBridgeApiUrl = (): string =>
  env.PUBLIC_BRIDGE_API_URL ?? DEFAULT_BRIDGE_API_URL;

export const getMintlayerApiUrl = (): string =>
  env.PUBLIC_MINTLAYER_API_URL ?? DEFAULT_MINTLAYER_API_URL;

/**
 * Server-side bridge API URL. Astro API routes run in Node, where
 * process.env takes precedence over the public (build-time) var — lets an
 * operator point server-side bridge calls at an internal mirror without
 * rebuilding, while the browser keeps using the public URL.
 */
export const getServerBridgeApiUrl = (): string =>
  process.env.BRIDGE_API_URL?.trim() ||
  env.PUBLIC_BRIDGE_API_URL ||
  DEFAULT_BRIDGE_API_URL;

/** Optional CoinGecko demo key for USD price lookups (display only). */
export const getCoingeckoApiKey = (): string =>
  env.PUBLIC_COINGECKO_API_KEY ?? '';
