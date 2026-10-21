import type { APIRoute } from 'astro';
import { json } from '@/lib/api-utils';
import { rpcCall, WalletRpcError } from '@/lib/wallet-rpc';
import { requireStepUp, totpFromBody } from '@/lib/step-up';

/**
 * POST /api/transaction-abandon - TOTP-gated abandon of a pending transaction.
 *
 * Abandoning un-reserves a pending transaction's inputs for re-spend, so it
 * is fund-affecting: it requires a fresh TOTP code (step-up) on top of the
 * session cookie, exactly like /api/send and /api/stake-trade. The method is
 * intentionally absent from the browser/plugin RPC allowlist - this endpoint
 * is the only path.
 *
 * Body: { totp_code, transaction_id }. The account is fixed server-side.
 */

export const POST: APIRoute = async ({ request, clientAddress }) => {
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await request.json();
    if (parsed !== null && typeof parsed === 'object') body = parsed as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: 'Invalid request body.' }, 400);
  }

  const transactionId = typeof body.transaction_id === 'string' ? body.transaction_id.trim() : '';
  // ML transaction ids are hex; refuse anything else before burning a code.
  if (!/^[0-9a-f]{16,80}$/i.test(transactionId)) {
    return json({ ok: false, error: 'A valid transaction id is required.' }, 400);
  }

  const stepUp = requireStepUp(totpFromBody(body), request, clientAddress as string | undefined);
  if (!stepUp.ok) {
    return json({ ok: false, error: stepUp.error }, stepUp.status);
  }

  try {
    await rpcCall('transaction_abandon', { account: 0, transaction_id: transactionId });
    return json({ ok: true }, 200);
  } catch (err) {
    if (err instanceof WalletRpcError) {
      // Transport-class failures (-32000/-32001 and daemon HTTP statuses)
      // embed the daemon URL in their message - redact like every other
      // money endpoint (send.ts, stake-trade.ts, rpc.ts) does.
      const transport = err.code === -32000 || err.code === -32001 || err.code >= 400;
      if (transport) console.error('[transaction-abandon]', err.message);
      return json(
        { ok: false, error: transport
          ? 'The wallet service is unavailable. Check that all services are running.'
          : err.message },
        502,
      );
    }
    return json(
      { ok: false, error: 'The wallet service is unavailable. Check that all services are running.' },
      502,
    );
  }
};
