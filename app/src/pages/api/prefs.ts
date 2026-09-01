import type { APIRoute } from 'astro';
import { getPref, setPref } from '@/lib/prefs-db';
import { json } from '@/lib/api-utils';

const KEY = 'ml_favourite_tokens';

export const GET: APIRoute = () => {
  try {
    const value = getPref<unknown[]>(KEY) ?? [];
    return json({ ok: true, value });
  } catch (err) {
    return json({ ok: false, error: String(err) }, 500);
  }
};

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    if (!Array.isArray(body)) return json({ ok: false, error: 'Expected array' }, 400);
    setPref(KEY, body);
    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: String(err) }, 500);
  }
};
