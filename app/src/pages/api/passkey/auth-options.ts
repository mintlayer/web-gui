import type { APIRoute } from 'astro';
import { generateAuthenticationOptions } from '@simplewebauthn/server';
import {
  getCredentials,
  createChallenge,
  getRpId,
  isValidRpId,
  makeChallengeCookieHeader,
} from '@/lib/passkey';

export const GET: APIRoute = async ({ request }) => {
  const rpId = getRpId(request.url);

  if (!isValidRpId(rpId)) {
    return new Response(JSON.stringify({ error: 'Passkeys require a DNS hostname.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
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

  return new Response(JSON.stringify(options), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': makeChallengeCookieHeader(token),
    },
  });
};
