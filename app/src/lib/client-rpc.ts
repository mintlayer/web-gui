/**
 * Shared browser-side helper for calling the `/api/rpc` proxy.
 * Throws with the RPC error message when the call fails.
 */
export async function rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch('/api/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params }),
  });
  const data = await res.json() as { ok: boolean; result?: T; error?: { message: string } };
  if (!data.ok) throw new Error(data.error?.message ?? 'RPC error');
  return data.result as T;
}
