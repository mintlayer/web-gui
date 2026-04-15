import type { APIRoute } from 'astro';
import { verifyRegistrationResponse } from '@simplewebauthn/server';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import {
  getCredentials,
  saveCredentials,
  consumeChallenge,
  getRpId,
  getOrigin,
  isValidRpId,
  PASSKEY_CHALLENGE_COOKIE,
  clearChallengeCookieHeader,
} from '@/lib/passkey';

export const POST: APIRoute = async ({ request }) => {
  const rpId = getRpId(request.url);
  const origin = getOrigin(request.url);

  if (!isValidRpId(rpId)) {
    return new Response(JSON.stringify({ error: 'Passkeys require a DNS hostname.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Extract challenge token from cookie
  const cookieHeader = request.headers.get('cookie') ?? '';
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${PASSKEY_CHALLENGE_COOKIE}=([^;]+)`));
  const token = match?.[1] ?? '';
  const expectedChallenge = token ? consumeChallenge(token) : null;

  if (!expectedChallenge) {
    return new Response(JSON.stringify({ error: 'Challenge expired or missing. Please try again.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Set-Cookie': clearChallengeCookieHeader() },
    });
  }

  let body: RegistrationResponseJSON & { name?: string };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid request body.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const credentialName = (body.name ?? 'Passkey').slice(0, 64).trim() || 'Passkey';

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpId,
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: `Verification failed: ${(err as Error).message}` }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Set-Cookie': clearChallengeCookieHeader() },
    });
  }

  if (!verification.verified || !verification.registrationInfo) {
    return new Response(JSON.stringify({ error: 'Registration not verified.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Set-Cookie': clearChallengeCookieHeader() },
    });
  }

  const { credential } = verification.registrationInfo;

  const creds = getCredentials();
  creds.push({
    id: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString('base64url'),
    counter: credential.counter,
    name: credentialName,
    createdAt: Date.now(),
  });
  saveCredentials(creds);

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': clearChallengeCookieHeader(),
    },
  });
};
