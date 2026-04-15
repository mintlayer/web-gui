import type { APIRoute } from 'astro';
import { generateRegistrationOptions } from '@simplewebauthn/server';
import {
  getCredentials,
  createChallenge,
  getRpId,
  getOrigin,
  isValidRpId,
  makeChallengeCookieHeader,
} from '@/lib/passkey';

export const GET: APIRoute = async ({ request }) => {
  const rpId = getRpId(request.url);

  if (!isValidRpId(rpId)) {
    return new Response(JSON.stringify({ error: 'Passkeys require a DNS hostname, not an IP address.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
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

  return new Response(JSON.stringify(options), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': makeChallengeCookieHeader(token),
    },
  });
};
