import type { APIRoute } from 'astro';
import { getPref, setPref } from '@/lib/prefs-db';
import { json } from '@/lib/api-utils';

const KEY = 'ml_favourite_tokens';
/** Safety cap — the mass import stays far below this client-side. */
const MAX_ENTRIES = 1000;

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

/** Tickers are rendered verbatim — reject control and bidi-override characters. */
const TICKER_BAD = /[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/;

/**
 * Validates one favourite entry and normalizes it to the `{tokenId, ticker}`
 * object shape. Accepts the current object shape and the legacy plain-string
 * shape (ticker unknown → short-id placeholder); anything else is rejected so
 * garbage can't be written into the shared store.
 */
function asFavouriteEntry(value: unknown): { tokenId: string; ticker: string } | null {
  if (isId(value)) return { tokenId: value, ticker: `${value.slice(0, 8)}…` };
  if (typeof value !== 'object' || value === null) return null;
  const e = value as Record<string, unknown>;
  if (!isId(e.tokenId)) return null;
  if (typeof e.ticker !== 'string' || e.ticker.length === 0 || e.ticker.length > 32) return null;
  if (TICKER_BAD.test(e.ticker)) return null;
  return { tokenId: e.tokenId, ticker: e.ticker };
}

export const GET: APIRoute = () => {
  try {
    const stored = getPref<unknown[]>(KEY) ?? [];
    // Defense-in-depth: serve only entries that pass the same validation
    // as POST (row may predate the validation or be hand-edited).
    const value = Array.isArray(stored)
      ? stored
          .map(asFavouriteEntry)
          .filter((e): e is { tokenId: string; ticker: string } => e !== null)
      : [];
    return json({ ok: true, value });
  } catch (err) {
    return json({ ok: false, error: String(err) }, 500);
  }
};

export const POST: APIRoute = async ({ request }) => {
  try {
    const declared = Number(request.headers.get('content-length') ?? '0');
    // 1000 entries × ~160 bytes ≪ 1MiB; refuse absurd bodies before parsing.
    if (Number.isFinite(declared) && declared > 1024 * 1024) {
      return json({ ok: false, error: 'Request body too large' }, 413);
    }
    const body = await request.json();
    if (!Array.isArray(body)) return json({ ok: false, error: 'Expected array' }, 400);
    if (body.length > MAX_ENTRIES) {
      return json({ ok: false, error: `Too many entries (max ${MAX_ENTRIES})` }, 400);
    }
    const validated: unknown[] = [];
    for (const raw of body) {
      const entry = asFavouriteEntry(raw);
      if (entry === null) return json({ ok: false, error: 'Invalid favourite entry' }, 400);
      validated.push(entry);
    }
    setPref(KEY, validated);
    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: String(err) }, 500);
  }
};
