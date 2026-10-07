import type { APIRoute } from 'astro';
import { setPref } from '@/lib/prefs-db';
import { json, readFormData } from '@/lib/api-utils';
import { requireStepUp } from '@/lib/step-up';

const VALID_PROVIDERS = new Set(['filebase', 'pinata', '']);

export const POST: APIRoute = async ({ request, clientAddress }) => {
  const form = await readFormData(request);
  if (!form) return json({ ok: false, error: 'Invalid request body' }, 400);

  // Coerce non-strings (e.g. File parts) to '' so they fail validation cleanly.
  const str = (v: FormDataEntryValue | null) => (typeof v === 'string' ? v : '');
  const provider      = str(form.get('provider'));
  const filebaseToken = str(form.get('filebase_token'));
  const pinataJwt     = str(form.get('pinata_jwt'));
  const totpCode      = str(form.get('totp_code'));

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
