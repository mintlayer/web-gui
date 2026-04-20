import type { APIRoute } from 'astro';
import { uninstallPlugin } from '@/lib/plugins';

export const POST: APIRoute = async ({ params }) => {
  const id = params.id ?? '';

  try {
    uninstallPlugin(id);
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
