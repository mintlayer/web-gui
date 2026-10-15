/**
 * Batched token-info resolution for browser components.
 *
 * `node_get_tokens_info` does not preserve input order, but every result
 * carries its own `content.token_id` — so instead of one RPC per token
 * we call it in chunks and align the answers by that field.
 */

import { rpc } from '@/lib/client-rpc';
import type { TokenInfo } from '@/lib/wallet-rpc';

/** Chunk size: keeps each RPC payload modest regardless of list size. */
export const TOKEN_INFO_CHUNK_SIZE = 50;

function tokenIdOf(info: TokenInfo | null): string | null {
  if (info === null) return null;
  const content = (info as { content?: { token_id?: unknown } }).content;
  return typeof content?.token_id === 'string' ? content.token_id : null;
}

/**
 * Resolves many token ids in batched calls.
 * Returns a Map with an entry for every requested id (null when the
 * chain answered nothing for it or an individual chunk failed).
 */
export async function getTokensInfoByIds(
  ids: string[],
): Promise<Map<string, TokenInfo | null>> {
  const out = new Map<string, TokenInfo | null>();
  for (const id of ids) out.set(id, null);

  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += TOKEN_INFO_CHUNK_SIZE) {
    const chunk = unique.slice(i, i + TOKEN_INFO_CHUNK_SIZE);
    try {
      const infos = await rpc<(TokenInfo | null)[]>('node_get_tokens_info', {
        token_ids: chunk,
      });
      // Order is not preserved — index the answers by their own token id.
      const byId = new Map<string, TokenInfo | null>();
      for (const info of infos ?? []) {
        const tid = tokenIdOf(info);
        if (tid !== null) byId.set(tid, info);
      }
      for (const id of chunk) {
        if (byId.has(id)) out.set(id, byId.get(id) ?? null);
      }
    } catch {
      // Chunk failed — remaining ids stay null; other chunks still resolve.
    }
  }
  return out;
}
