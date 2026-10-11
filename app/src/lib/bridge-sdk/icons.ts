import { getMintlayerApiUrl } from './config';
import { apiRequest } from './http';
import type { FetchLike } from './http';

const IPFS_PROXY = '/ipfs/';

/** Converts ipfs:// URIs to the same-origin gateway proxy; passes http(s) through. */
export const toGatewayUrl = (uri: string): string => {
  if (uri.startsWith('ipfs://ipfs/')) return IPFS_PROXY + uri.slice('ipfs://ipfs/'.length);
  if (uri.startsWith('ipfs://')) return IPFS_PROXY + uri.slice('ipfs://'.length);
  return uri;
};

interface RawTokenInfo {
  metadata_uri?: { string?: string };
  icon_uri?: { string?: string };
}

/**
 * Resolves a token's display icon URL from its on-chain metadata:
 * token info → metadata_uri (usually an IPFS JSON document) → tokenIcon.
 * Returns null when any step is missing or fails.
 */
export async function resolveTokenIcon(
  tokenId: string,
  deps: { mintlayerApiUrl?: string; fetchImpl?: FetchLike } = {},
): Promise<string | null> {
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

  try {
    const metadata = await apiRequest<Record<string, unknown>>(
      toGatewayUrl(metadataUri),
      {},
      fetchImpl,
    );
    const icon =
      metadata.tokenIcon ??
      metadata.icon_uri ??
      metadata.icon ??
      metadata.image;
    if (typeof icon === 'string' && icon.length > 0) {
      return toGatewayUrl(icon);
    }
    return null;
  } catch {
    return null;
  }
}
