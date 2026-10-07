import type { APIRoute } from 'astro';
import { setPref } from '@/lib/prefs-db';
import { json, readFormData } from '@/lib/api-utils';
import { requireStepUp } from '@/lib/step-up';

const VALID_PROVIDERS = new Set(['filebase', 'pinata', '']);

export const POST: APIRoute = async ({ request, clientAddress }) => {
  const form = await readFormData(request);
  if (!form) return json({ ok: false, error: 'Invalid request body' }, 400);

  const provider      = (form.get('provider')       as string | null) ?? '';
  const filebaseToken = (form.get('filebase_token') as string | null) ?? '';
  const pinataJwt     = (form.get('pinata_jwt')     as string | null) ?? '';
  const totpCode      = (form.get('totp_code')      as string | null) ?? '';

  if (!VALID_PROVIDERS.has(provider)) {
    return json({ ok: false, error: `Invalid provider: ${provider}` }, 400);
  }

  // Pinata/Filebase keys are third-party account credentials: whoever sets
  // them can pivot into the owner's pinning account. Same sensitivity class
  // as the Telegram bot token — fresh 2FA code required.
  const stepUp = requireStepUp(totpCode, request, clientAddress);
  if (!stepUp.ok) {
    return json({ ok: false, error: stepUp.error }, stepUp.status);
  }

  setPref('ipfs.provider',       provider);
  setPref('ipfs.filebase_token', filebaseToken);
  setPref('ipfs.pinata_jwt',     pinataJwt);

  return json({ ok: true }, 200);
};
