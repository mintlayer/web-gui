import type { APIRoute } from 'astro';
import { verifyRegistrationResponse } from '@simplewebauthn/server';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import {
  getCredentials,
  saveCredentials,
  consumeChallengeFromRequest,
  getRpId,
  getOrigin,
  isValidRpId,
  clearChallengeCookieHeader,
} from '@/lib/passkey';
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

  let body: RegistrationResponseJSON & { name?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid request body.' }, 400);
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
    return json({ error: `Verification failed: ${(err as Error).message}` }, 400, {
      'Set-Cookie': clearChallengeCookieHeader(),
    });
  }

  if (!verification.verified || !verification.registrationInfo) {
    return json({ error: 'Registration not verified.' }, 400, {
      'Set-Cookie': clearChallengeCookieHeader(),
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

  return json({ ok: true }, 200, {
    'Set-Cookie': clearChallengeCookieHeader(),
  });
};
