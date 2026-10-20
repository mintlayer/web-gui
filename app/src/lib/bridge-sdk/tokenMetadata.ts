import { getMintlayerApiUrl } from './config';
import { apiRequest } from './http';
import type { FetchLike } from './http';
import { toGatewayUrl } from './gateway';

/**
 * On-chain token metadata is UNTRUSTED content (anyone can register a
 * token). Everything here is strictly display-only: length-capped text,
 * http(s)-only links, gateway/http(s)-only icon URLs. It must never
 * feed amounts, decimals math, or addresses.
 */

/** Max length for short text fields (name, symbol, tag, link, id). */
const MAX_TEXT_LENGTH = 120;
/** Max length for the token description. */
const MAX_DESCRIPTION_LENGTH = 400;
/** Max number of tags kept from the metadata document. */
const MAX_TAGS = 8;

export interface TokenMetadataLinks {
  website?: string;
  coingecko?: string;
}

export interface TokenMetadata {
  name?: string;
  description?: string;
  symbol?: string;
  /** Display hint only - amount math always uses chain/fallback decimals. */
  decimals?: number;
  /** Gateway-safe icon URL ready for <img src>. */
  icon?: string;
  origin?: { chain?: string; address?: string };
  tags?: string[];
  links?: TokenMetadataLinks;
}

interface RawTokenInfo {
  metadata_uri?: { string?: string };
  icon_uri?: { string?: string };
}

const isHttpUrl = (value: string): boolean => /^https?:\/\//i.test(value);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** Trimmed, length-capped text; undefined for anything else. */
const clipText = (value: unknown, max: number): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, max);
};

/** Links render as anchors - only http(s) URLs may pass through. */
const clipLink = (value: unknown): string | undefined => {
  const text = clipText(value, MAX_TEXT_LENGTH);
  return text && isHttpUrl(text) ? text : undefined;
};

/**
 * Icon URLs may only be same-origin gateway paths (no protocol-relative
 * "//host", which would be cross-origin) or http(s) URLs. Note: the
 * deployed CSP restricts img-src to same-origin/data/blob, so external
 * http(s) icons fail closed at runtime - the allowance here exists for
 * environments without the CSP header.
 */
const clipIcon = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  const url = toGatewayUrl(value.trim());
  // Overlong URLs would render broken after clipping - drop them.
  if (url.length > MAX_TEXT_LENGTH) return undefined;
  const sameOriginPath =
    url.startsWith('/') && !url.startsWith('//') && !url.includes('\\');
  return sameOriginPath || isHttpUrl(url) ? url : undefined;
};

/** Integer decimals in the sane 0–18 range; display hint only. */
const clipDecimals = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined;
  return value >= 0 && value <= 18 ? value : undefined;
};

const clipTags = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const tags = Array.from(
    new Set(
      value
        .map((tag) => clipText(tag, MAX_TEXT_LENGTH))
        .filter((tag): tag is string => tag !== undefined),
    ),
  ).slice(0, MAX_TAGS);
  return tags.length > 0 ? tags : undefined;
};

/**
 * Reduces an untrusted metadata JSON document to the safe display
 * fields the UI renders. Returns null when nothing usable survives.
 */
export function sanitizeTokenMetadata(raw: unknown): TokenMetadata | null {
  if (!isRecord(raw)) return null;

  const metadata: TokenMetadata = {};

  const name = clipText(raw.name, MAX_TEXT_LENGTH);
  if (name) metadata.name = name;

  const description = clipText(raw.description, MAX_DESCRIPTION_LENGTH);
  if (description) metadata.description = description;

  const symbol = clipText(raw.symbol, MAX_TEXT_LENGTH);
  if (symbol) metadata.symbol = symbol;

  const decimals = clipDecimals(raw.decimals);
  if (decimals !== undefined) metadata.decimals = decimals;

  // Same icon fallback chain resolveTokenIcon has always used.
  // logo_uri: the schema actually published on-chain (e.g. mlUSDC
  // metadata) puts the logo there.
  const icon = clipIcon(
    raw.tokenIcon ?? raw.icon_uri ?? raw.logo_uri ?? raw.icon ?? raw.image,
  );
  if (icon) metadata.icon = icon;

  if (isRecord(raw.origin)) {
    const origin = {
      chain: clipText(raw.origin.chain, MAX_TEXT_LENGTH),
      address: clipText(raw.origin.address, MAX_TEXT_LENGTH),
    };
    if (origin.chain || origin.address) metadata.origin = origin;
  }

  const tags = clipTags(raw.tags);
  if (tags) metadata.tags = tags;

  if (isRecord(raw.links)) {
    const links: TokenMetadataLinks = {
      website: clipLink(raw.links.website),
      coingecko: clipLink(raw.links.coingecko),
    };
    if (links.website || links.coingecko) metadata.links = links;
  }

  return Object.keys(metadata).length > 0 ? metadata : null;
}

/**
 * Resolves a token's sanitized display metadata: token info →
 * metadata_uri (usually an IPFS JSON document) → sanitized fields.
 * Returns null when any step is missing or fails - the UI must
 * degrade to ticker-only display, never guess.
 */
export async function resolveTokenMetadata(
  tokenId: string,
  deps: { mintlayerApiUrl?: string; fetchImpl?: FetchLike } = {},
): Promise<TokenMetadata | null> {
  const mlUrl = deps.mintlayerApiUrl ?? getMintlayerApiUrl();
  const fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));

  let info: RawTokenInfo;
  try {
    info = await apiRequest<RawTokenInfo>(
      `${mlUrl}token/${encodeURIComponent(tokenId)}`,
      {},
      fetchImpl,
    );
  } catch {
    return null;
  }

  const metadataUri = info.metadata_uri?.string ?? info.icon_uri?.string;
  if (!metadataUri) return null;

  // Scheme allowlist before any fetch: the metadata document is chosen
  // by the token issuer, and fetching it from every viewer's browser
  // would otherwise double as a tracking beacon. Only IPFS (via the
  // same-origin gateway) and https are fetchable.
  const trimmed = metadataUri.trim();
  if (!trimmed.startsWith('ipfs:') && !trimmed.startsWith('https:')) {
    return null;
  }

  try {
    const raw = await apiRequest<unknown>(
      toGatewayUrl(trimmed),
      {},
      fetchImpl,
    );
    return sanitizeTokenMetadata(raw);
  } catch {
    return null;
  }
}
