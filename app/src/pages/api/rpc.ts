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

  // A huge lookahead makes the daemon generate massive address batches -
  // persistent wallet-file bloat that outlives the session. Clamp it here:
  // the daemon treats the field as a plain unbounded number and this
  // method is the only allowlisted write with no natural bound.
  if (method === 'wallet_set_lookahead_size') {
    const size = Number((rpcParams as Record<string, unknown>).lookahead_size);
    if (!Number.isInteger(size) || size < 0 || size > 10_000) {
      return jsonError('lookahead_size must be an integer in [0, 10000]', 400);
    }
    (rpcParams as Record<string, unknown>).lookahead_size = size;
  }

  try {
    const result = await rpcCall(method, rpcParams);
    return new Response(JSON.stringify({ ok: true, result }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const code = err instanceof WalletRpcError ? err.code : -1;
    // Only forward JSON-RPC-class daemon errors. -32000/-32001 are the
    // transport band (daemon URL in the message); anything outside the
    // -32700..-32002 JSON-RPC error space (HTTP 401/404 on bad daemon
    // credentials, 5xx) carries internal details and is redacted.
    const forwardable =
      err instanceof WalletRpcError &&
      code !== -32000 && code !== -32001 &&
      code >= -32700 && code <= -32002;
    const message = forwardable ? err.message : 'The wallet service is unavailable. Check that all services are running.';
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
