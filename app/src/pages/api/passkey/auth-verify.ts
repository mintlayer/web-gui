import type { APIRoute } from 'astro';
import { verifyAuthenticationResponse } from '@simplewebauthn/server';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
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
import { generateSessionToken, makeSessionCookieHeader } from '@/lib/auth';

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

  let body: AuthenticationResponseJSON;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid request body.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const creds = getCredentials();
  const storedCred = creds.find((c) => c.id === body.id);

  if (!storedCred) {
    return new Response(JSON.stringify({ error: 'Passkey not registered.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Set-Cookie': clearChallengeCookieHeader() },
    });
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: body,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpId,
      credential: {
        id: storedCred.id,
        publicKey: Buffer.from(storedCred.publicKey, 'base64url'),
        counter: storedCred.counter,
        transports: ['internal', 'hybrid'] as AuthenticatorTransport[],
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: `Verification failed: ${(err as Error).message}` }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Set-Cookie': clearChallengeCookieHeader() },
    });
  }

  if (!verification.verified) {
    return new Response(JSON.stringify({ error: 'Authentication not verified.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Set-Cookie': clearChallengeCookieHeader() },
    });
  }

  // Update counter (anti-replay)
  storedCred.counter = verification.authenticationInfo.newCounter;
  saveCredentials(creds);

  // Issue session
  const sessionToken = generateSessionToken();

  const headers = new Headers({ 'Content-Type': 'application/json' });
  headers.append('Set-Cookie', makeSessionCookieHeader(sessionToken));
  headers.append('Set-Cookie', clearChallengeCookieHeader());

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
};
