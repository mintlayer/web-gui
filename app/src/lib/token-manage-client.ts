/**
 * Browser-side helper for the TOTP-gated /api/token-manage endpoint.
 *
 * Every token-authority action (issue/mint/unmint/lock/freeze/change) burns a
 * 2FA code, so failures must tell the user whether their code was consumed
 * (code_consumed) and whether they need to sign in again (sessionExpired) —
 * same contract as the send/bridge flows.
 */

export type TokenManageSuccess = { ok: true; result: Record<string, unknown> };

export type TokenManageFailure = {
  ok: false;
  error: string;
  status: number;
  code_consumed?: boolean;
  sessionExpired?: boolean;
};

export type TokenManageResponse = TokenManageSuccess | TokenManageFailure;

export async function tokenManage(
  action: string,
  params: Record<string, unknown>,
  totpCode: string,
): Promise<TokenManageResponse> {
  let res: Response;
  try {
    res = await fetch('/api/token-manage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, params, totp_code: totpCode }),
    });
  } catch {
    return {
      ok: false,
      error: 'Could not reach the server. Check your connection and try again.',
      status: 0,
    };
  }

  // The auth middleware answers an expired session with a 302 to /login;
  // fetch follows it transparently (res.redirected) and lands on HTML.
  if (res.redirected || (res.status === 401 && !(res.headers.get('content-type') ?? '').includes('application/json'))) {
    window.setTimeout(() => window.location.assign('/login'), 800);
    return {
      ok: false,
      error: 'Your session expired — redirecting to login…',
      status: 401,
      sessionExpired: true,
    };
  }

  let data: { ok?: boolean; result?: Record<string, unknown>; error?: string; code_consumed?: boolean } | null = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!data) {
    return {
      ok: false,
      error: `Token operation failed (HTTP ${res.status}) — nothing was submitted.`,
      status: res.status,
    };
  }

  if (data.ok) {
    return { ok: true, result: data.result ?? {} };
  }

  return {
    ok: false,
    error: data.error ?? `Token operation failed (HTTP ${res.status}).`,
    status: res.status,
    code_consumed: data.code_consumed === true,
  };
}
