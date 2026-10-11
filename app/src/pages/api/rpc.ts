import type { APIRoute } from 'astro';
import { rpcCall, WalletRpcError } from '@/lib/wallet-rpc';
import { checkRpcRateLimit, getClientAddress } from '@/lib/auth';
import { ALLOWED_RPC_METHODS } from '@/lib/rpc-allowlist';

export const POST: APIRoute = async ({ request, clientAddress }) => {
  // Socket address first; x-forwarded-for only when TRUST_PROXY=true.
  // Falls back to 'unknown' when the adapter does not expose clientAddress.
  const ip = getClientAddress(request, clientAddress as string | undefined);
  if (!checkRpcRateLimit(ip)) {
    return jsonError('Rate limit exceeded', 429);
  }

  let body: { method?: unknown; params?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  const { method, params } = body;

  if (typeof method !== 'string' || !method) {
    return jsonError('"method" must be a non-empty string', 400);
  }

  if (!ALLOWED_RPC_METHODS.has(method)) {
    return jsonError(`Method "${method}" is not allowed`, 403);
  }

  const rpcParams =
    params != null && typeof params === 'object' && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : {};

  try {
    const result = await rpcCall(method, rpcParams);
    return new Response(JSON.stringify({ ok: true, result }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const code = err instanceof WalletRpcError ? err.code : -1;
    // Transport-level failures (-32000/-32001) and daemon 5xx carry internal
    // details (daemon URL, HTTP status text) in their messages — never forward
    // them to the browser. The full error is logged above for server-side
    // diagnostics; the client gets an actionable, information-free message.
    const message =
      err instanceof WalletRpcError && code !== -32000 && code !== -32001 && code < 500
        ? err.message
        : 'The wallet service is unavailable. Check that all services are running.';
    console.error('[rpc-proxy]', method, err);
    return new Response(
      JSON.stringify({ ok: false, error: { message, code } }),
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    );
  }
};

function jsonError(message: string, status: number, code: number = 0) {
  return new Response(JSON.stringify({ ok: false, error: { message, code } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
