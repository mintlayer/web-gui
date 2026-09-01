import type { APIRoute } from 'astro';
import { verifyAuthenticationResponse } from '@simplewebauthn/server';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import {
  getCredentials,
  saveCredentials,
  consumeChallengeFromRequest,
  getRpId,
  getOrigin,
  isValidRpId,
  clearChallengeCookieHeader,
} from '@/lib/passkey';
import { generateSessionToken, makeSessionCookieHeader } from '@/lib/auth';
import { getPref } from '@/lib/prefs-db';
import { json } from '@/lib/api-utils';

export const POST: APIRoute = async ({ request }) => {
  const rpId = getRpId(request.url);
  const origin = getOrigin(request.url);

  if (!isValidRpId(rpId)) {
    return json({ error: 'Passkeys require a DNS hostname.' }, 400);
  }

  const expectedChallenge = consumeChallengeFromRequest(request);

  if (!expectedChallenge) {
    return json({ error: 'Challenge expired or missing. Please try again.' }, 400, {
      'Set-Cookie': clearChallengeCookieHeader(),
    });
  }

  let body: AuthenticationResponseJSON;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid request body.' }, 400);
  }

  const creds = getCredentials();
  const storedCred = creds.find((c) => c.id === body.id);

  if (!storedCred) {
    return json({ error: 'Passkey not registered.' }, 400, {
      'Set-Cookie': clearChallengeCookieHeader(),
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
    return json({ error: `Verification failed: ${(err as Error).message}` }, 400, {
      'Set-Cookie': clearChallengeCookieHeader(),
    });
  }

  if (!verification.verified) {
    return json({ error: 'Authentication not verified.' }, 400, {
      'Set-Cookie': clearChallengeCookieHeader(),
    });
  }

  // Update counter (anti-replay)
  storedCred.counter = verification.authenticationInfo.newCounter;
  saveCredentials(creds);

  // Issue session at the current version (matches middleware's session-version check)
  const sessionVersion = getPref<number>('auth.session_version') ?? 0;
  const sessionToken = generateSessionToken(sessionVersion);

  const headers = new Headers({ 'Content-Type': 'application/json' });
  headers.append('Set-Cookie', makeSessionCookieHeader(sessionToken));
  headers.append('Set-Cookie', clearChallengeCookieHeader());

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
};
