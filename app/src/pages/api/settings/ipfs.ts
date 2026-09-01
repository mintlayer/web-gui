import type { APIRoute } from 'astro';
import { setPref } from '@/lib/prefs-db';
import { json, readFormData } from '@/lib/api-utils';

const VALID_PROVIDERS = new Set(['filebase', 'pinata', '']);

export const POST: APIRoute = async ({ request }) => {
  const form = await readFormData(request);
  if (!form) return json({ ok: false, error: 'Invalid request body' }, 400);

  const provider      = (form.get('provider')       as string | null) ?? '';
  const filebaseToken = (form.get('filebase_token') as string | null) ?? '';
  const pinataJwt     = (form.get('pinata_jwt')     as string | null) ?? '';

  if (!VALID_PROVIDERS.has(provider)) {
    return json({ ok: false, error: `Invalid provider: ${provider}` }, 400);
  }

  setPref('ipfs.provider',       provider);
  setPref('ipfs.filebase_token', filebaseToken);
  setPref('ipfs.pinata_jwt',     pinataJwt);

  return json({ ok: true }, 200);
};
