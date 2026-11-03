import type { APIRoute } from 'astro';
import { verifyRegistrationResponse } from '@simplewebauthn/server';
import type { RegistrationResponseJSON, AuthenticatorTransport } from '@simplewebauthn/server';
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
  const rpId = getRpId(request);
  const origin = getOrigin(request);

  if (!isValidRpId(rpId)) {
    return json({ error: 'Passkeys require a DNS hostname.' }, 400);
  }

  const expectedChallenge = consumeChallengeFromRequest(request, 'registration');

  if (!expectedChallenge) {
    return json({ error: 'Challenge expired or missing. Please try again.' }, 400, {
      'Set-Cookie': clearChallengeCookieHeader(),
    });
  }

  // Authority note: this endpoint persists a login credential, but it can only
  // run with a challenge tagged purpose='registration' - register-options
  // mints those only AFTER a successful 2FA step-up burn, while the public
  // auth-options route mints 'authentication' challenges that are rejected
  // here (consumeChallenge deletes the entry either way). The challenge
  // cookie is single-use and expires in minutes, so no separate TOTP check
  // is needed here.

  let body: RegistrationResponseJSON & { name?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid request body.' }, 400);
  }
  // request.json() parses JSON literals like `null` fine; the reads below
  // need a real object.
  if (body == null || typeof body !== 'object') {
    return json({ error: 'Invalid request body.' }, 400);
  }

  const credentialName =
    (typeof body.name === 'string' ? body.name : 'Passkey').slice(0, 64).trim() || 'Passkey';

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
    // Remember how this key connects (usb/nfc/ble/internal/hybrid/cable)
    // so auth-options can advertise it; hardcoding a subset here used to
    // make enrolled USB/NFC keys unlistable at sign-in. Unknown future
    // transport names are filtered out so the stored value stays a plain
    // AuthenticatorTransport[].
    transports: credential.transports?.filter(
      (t): t is AuthenticatorTransport =>
        ['usb', 'nfc', 'ble', 'internal', 'hybrid'].includes(t),
    ),
  });
  saveCredentials(creds);

  return json({ ok: true }, 200, {
    'Set-Cookie': clearChallengeCookieHeader(),
  });
};
