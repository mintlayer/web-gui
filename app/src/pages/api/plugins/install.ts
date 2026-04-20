import type { APIRoute } from 'astro';
import { installPlugin } from '@/lib/plugins';

export const POST: APIRoute = async ({ request }) => {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return json({ ok: false, error: 'Invalid multipart form data' }, 400);
  }

  const file = formData.get('plugin') as File | null;
  if (!file || typeof file === 'string') {
    return json({ ok: false, error: 'Missing "plugin" file field' }, 400);
  }

  const MAX_SIZE = 50 * 1024 * 1024; // 50 MB
  if (file.size > MAX_SIZE) {
    return json({ ok: false, error: 'Plugin archive too large (max 50 MB)' }, 400);
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  try {
    const manifest = await installPlugin(buffer);
    return json({ ok: true, plugin: manifest });
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
