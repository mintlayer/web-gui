import type { APIRoute } from 'astro';
import { generateRegistrationOptions } from '@simplewebauthn/server';
import {
  getCredentials,
  createChallenge,
  getRpId,
  isValidRpId,
  makeChallengeCookieHeader,
} from '@/lib/passkey';
import { json } from '@/lib/api-utils';
import { requireStepUp } from '@/lib/step-up';

export const POST: APIRoute = async ({ request, clientAddress }) => {
  const rpId = getRpId(request.url);

  if (!isValidRpId(rpId)) {
    return json({ error: 'Passkeys require a DNS hostname, not an IP address.' }, 400);
  }

  // Enrolling a passkey grants persistent login (it survives cookie theft —
  // that is its purpose), so it needs the same fresh 2FA code as other
  // step-up-gated changes. The code is burned HERE, before the challenge is
  // issued: challenges are single-use and short-lived, so register-verify can
  // only complete when this check passed moments before. Burning up front also
  // means a mistyped code never strands the user mid-ceremony.
  let totpCode = '';
  try {
    const body = (await request.json()) as { totp_code?: unknown };
    totpCode = typeof body.totp_code === 'string' ? body.totp_code : '';
  } catch {
    return json({ error: 'Invalid request body.' }, 400);
  }
  const stepUp = requireStepUp(totpCode, request, clientAddress);
  if (!stepUp.ok) {
    return json({ error: stepUp.error }, stepUp.status);
  }

  const existingCreds = getCredentials();

  const options = await generateRegistrationOptions({
    rpName: 'Mintlayer GUI-X',
    rpID: rpId,
    userName: 'wallet',
    userDisplayName: 'Mintlayer Wallet',
    attestationType: 'none',
    excludeCredentials: existingCreds.map((c) => ({
      id: c.id,
      transports: ['internal', 'hybrid'] as AuthenticatorTransport[],
    })),
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
  });

  const token = createChallenge(options.challenge);

  return json(options, 200, {
    'Set-Cookie': makeChallengeCookieHeader(token),
  });
};
