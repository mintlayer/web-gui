import type { APIRoute } from 'astro';
import { setPref, getStringPref } from '@/lib/prefs-db';
import { json, LOGIN_BODY_LIMIT, readFormWithinLimit } from '@/lib/api-utils';
import { requireStepUp } from '@/lib/step-up';

const VALID_PROVIDERS = new Set(['filebase', 'pinata', '']);

export const POST: APIRoute = async ({ request, clientAddress }) => {
  // Body cap: request.formData() buffers the whole body before validation.
  const form = await readFormWithinLimit(request, LOGIN_BODY_LIMIT);
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
  // as the Telegram bot token - fresh 2FA code required.
  const stepUp = requireStepUp(totpCode, request, clientAddress);
  if (!stepUp.ok) {
    return json({ ok: false, error: stepUp.error }, stepUp.status);
  }

  // Secrets are write-only (same contract as the settings page): blank input
  // keeps the stored key, so a "just change the provider" call cannot wipe it.
  const storedFilebase = getStringPref('ipfs.filebase_token') ?? '';
  const storedPinata   = getStringPref('ipfs.pinata_jwt') ?? '';
  if (provider === 'filebase' && !filebaseToken && !storedFilebase) {
    return json({ ok: false, error: 'Paste your Filebase access key - pinning cannot work without it.' }, 400);
  }
  if (provider === 'pinata' && !pinataJwt && !storedPinata) {
    return json({ ok: false, error: 'Paste your Pinata JWT - pinning cannot work without it.' }, 400);
  }

  setPref('ipfs.provider',       provider);
  // Disabling IPFS also clears any stored provider keys - keeping them on
  // disk while "Disabled" protects nothing and leaves third-party
  // credentials behind.
  setPref('ipfs.filebase_token', provider === '' ? '' : (filebaseToken || storedFilebase));
  setPref('ipfs.pinata_jwt',     provider === '' ? '' : (pinataJwt || storedPinata));

  return json({ ok: true }, 200);
};
