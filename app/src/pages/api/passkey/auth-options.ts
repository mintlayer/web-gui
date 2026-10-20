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
import { checkRpcRateLimit, getClientAddress } from '@/lib/auth';

export const GET: APIRoute = async ({ request, clientAddress }) => {
  // Pre-auth route: throttle challenge generation per IP.
  if (!checkRpcRateLimit(getClientAddress(request, clientAddress))) {
    return json({ error: 'Too many requests. Please slow down.' }, 429);
  }

  const rpId = getRpId(request.url);

  if (!isValidRpId(rpId)) {
    return json({ error: 'Passkeys require a DNS hostname.' }, 400);
  }

  const creds = getCredentials();

  const options = await generateAuthenticationOptions({
    rpID: rpId,
    allowCredentials: creds.map((c) => ({
      id: c.id,
      // Replay the transports the key reported at registration. Omitting
      // the hint (legacy records) makes browsers probe every transport, so
      // USB/NFC keys enrolled before this field existed keep working.
      ...(c.transports && c.transports.length > 0 ? { transports: c.transports } : {}),
    })),
    // Verification is required by verifyAuthenticationResponse's default,
    // so the ceremony must ask the authenticator for it up front; asking
    // for 'preferred' would let non-UV assertions in that then fail
    // verification (dead-end loop that burns a TOTP code per retry).
    userVerification: 'required',
  });

  const token = createChallenge(options.challenge, 'authentication');

  return json(options, 200, {
    'Set-Cookie': makeChallengeCookieHeader(token),
  });
};
