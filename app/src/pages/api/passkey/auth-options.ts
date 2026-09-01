import type { APIRoute } from 'astro';
import { generateAuthenticationOptions } from '@simplewebauthn/server';
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
    return json({ error: 'Passkeys require a DNS hostname.' }, 400);
  }

  const creds = getCredentials();

  const options = await generateAuthenticationOptions({
    rpID: rpId,
    allowCredentials: creds.map((c) => ({
      id: c.id,
      transports: ['internal', 'hybrid'] as AuthenticatorTransport[],
    })),
    userVerification: 'preferred',
  });

  const token = createChallenge(options.challenge);

  return json(options, 200, {
    'Set-Cookie': makeChallengeCookieHeader(token),
  });
};
