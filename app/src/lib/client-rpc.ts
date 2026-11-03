/**
 * Shared browser-side helper for calling the `/api/rpc` proxy.
 * Throws with the RPC error message when the call fails.
 */
export async function rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch('/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, params }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new Error('The wallet service took too long to answer.');
    }
    throw new Error('Could not reach the wallet service.');
  }
  // A proxy or error page can answer with HTML - report the status
  // instead of a JSON parse error.
  let data: { ok: boolean; result?: T; error?: { message: string } };
  try {
    data = await res.json();
  } catch {
    throw new Error(`Wallet service error (HTTP ${res.status}).`);
  }
  if (!res.ok) {
    throw new Error(data.error?.message ?? `Wallet service error (HTTP ${res.status}).`);
  }
  if (!data.ok) throw new Error(data.error?.message ?? 'RPC error');
  return data.result as T;
}
