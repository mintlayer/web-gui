import type { APIRoute } from 'astro';
import { togglePlugin } from '@/lib/plugins';

export const POST: APIRoute = async ({ params, request }) => {
  const id = params.id ?? '';

  let body: { enabled?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  if (typeof body.enabled !== 'boolean') {
    return json({ ok: false, error: '"enabled" must be a boolean' }, 400);
  }

  try {
    togglePlugin(id, body.enabled);
    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: (err as Error).message }, 422);
  }
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
