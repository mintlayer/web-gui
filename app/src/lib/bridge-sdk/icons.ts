import { toGatewayUrl } from './gateway';
import { resolveTokenMetadata } from './tokenMetadata';
import type { FetchLike } from './http';

export { toGatewayUrl };

/**
 * Resolves a token's display icon URL from its on-chain metadata.
 * Thin convenience wrapper over resolveTokenMetadata — the icon is the
 * one sanitized field of the same metadata document.
 * Returns null when any step is missing or fails.
 */
export async function resolveTokenIcon(
  tokenId: string,
  deps: { mintlayerApiUrl?: string; fetchImpl?: FetchLike } = {},
): Promise<string | null> {
  const metadata = await resolveTokenMetadata(tokenId, deps);
  return metadata?.icon ?? null;
}
