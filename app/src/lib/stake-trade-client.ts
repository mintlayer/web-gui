/**
 * Browser-side helper for the TOTP-gated /api/stake-trade endpoint.
 *
 * Staking, pool and order actions burn a 2FA code, so failures must tell the
 * user whether their code was consumed (code_consumed) and whether they need
 * to sign in again (sessionExpired) — same contract as the send/bridge/token
 * flows. Accepts a single action or a small ordered batch (one burn total).
 */

export type StakeAction = { action: string; params: Record<string, unknown> };

export type StakeTradeSuccess = { ok: true; results: Record<string, unknown>[] };

export type StakeTradeFailure = {
  ok: false;
  error: string;
  status: number;
  code_consumed?: boolean;
  completed?: number;
  sessionExpired?: boolean;
};

export type StakeTradeResponse = StakeTradeSuccess | StakeTradeFailure;

export async function stakeTrade(
  actions: StakeAction | StakeAction[],
  totpCode: string,
): Promise<StakeTradeResponse> {
  const batch = Array.isArray(actions) ? actions : [actions];
  let res: Response;
  try {
    res = await fetch('/api/stake-trade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actions: batch, totp_code: totpCode }),
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

  let data: {
    ok?: boolean;
    results?: Record<string, unknown>[];
    error?: string;
    code_consumed?: boolean;
    completed?: number;
  } | null = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!data) {
    return {
      ok: false,
      error: `Operation failed (HTTP ${res.status}) — nothing was submitted.`,
      status: res.status,
    };
  }

  if (data.ok) {
    return { ok: true, results: data.results ?? [] };
  }

  return {
    ok: false,
    error: data.error ?? `Operation failed (HTTP ${res.status}).`,
    status: res.status,
    code_consumed: data.code_consumed === true,
    completed: typeof data.completed === 'number' ? data.completed : undefined,
  };
}
