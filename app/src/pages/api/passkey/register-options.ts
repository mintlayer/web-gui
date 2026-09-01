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

export const GET: APIRoute = async ({ request }) => {
  const rpId = getRpId(request.url);

  if (!isValidRpId(rpId)) {
    return json({ error: 'Passkeys require a DNS hostname, not an IP address.' }, 400);
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
