/**
 * GET /api/block-stream
 *
 * Server-Sent Events endpoint. Connects to the wallet-rpc-daemon WebSocket,
 * subscribes to wallet events, and forwards NewBlock notifications to the
 * browser. This keeps daemon credentials out of the browser entirely.
 */

import type { APIRoute } from 'astro';
import WebSocket from 'ws';
import { verifySessionToken, SESSION_COOKIE_NAME } from '@/lib/auth';
import { getPref } from '@/lib/prefs-db';
import { getWalletRpcWsUrl } from '@/lib/wallet-rpc';

export const GET: APIRoute = async ({ request }) => {
  // Auth check - browsers send cookies with same-origin EventSource (per spec)
  const cookieHeader = request.headers.get('cookie') ?? '';
  const sessionToken =
    cookieHeader.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE_NAME}=([^;]+)`))?.[1] ?? '';
  // Verify against the CURRENT session version - hardcoding 0 let pre-password-
  // change tokens stay valid here after revocation (and broke new tokens).
  const sessionVersion = getPref<number>('auth.session_version') ?? 0;
  if (!verifySessionToken(sessionToken, sessionVersion)) {
    return new Response('Unauthorized', { status: 401 });
  }

  // URL construction shared with the RPC client (consistent env + fallback)
  const wsUrl = getWalletRpcWsUrl();
  const username  = process.env.WALLET_RPC_USERNAME ?? '';
  const password  = process.env.WALLET_RPC_PASSWORD ?? '';
  const auth  = Buffer.from(`${username}:${password}`).toString('base64');

  const encoder = new TextEncoder();

  const body = new ReadableStream({
    start(controller) {
      const send = (data: Record<string, unknown>) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          // controller already closed
        }
      };

      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl, {
          headers: { Authorization: `Basic ${auth}` },
        });
      } catch (err) {
        send({ type: 'error', message: String(err) });
        controller.close();
        return;
      }

      ws.on('open', () => {
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'subscribe_wallet_events',
          params: {},
        }));
        // Tell the browser the upstream connection is healthy
        send({ type: 'connected' });
      });

      ws.on('message', (raw) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(raw.toString()) as Record<string, unknown>;
        } catch {
          return;
        }

        // jsonrpsee subscription notification:
        // { method: "subscribe_wallet_events", params: { subscription: "...", result: <Event> } }
        const params = msg.params as Record<string, unknown> | undefined;
        const result = params?.result as Record<string, unknown> | undefined;
        if (!result) return;

        if ('NewBlock' in result) {
          send({ type: 'NewBlock' });
        } else if ('TxUpdated' in result) {
          const ev = result['TxUpdated'] as Record<string, unknown>;
          send({ type: 'TxUpdated', tx_id: ev['tx_id'], state: ev['state'] });
        } else if ('TxDropped' in result) {
          const ev = result['TxDropped'] as Record<string, unknown>;
          send({ type: 'TxDropped', tx_id: ev['tx_id'] });
        }
      });

      // Comment-style heartbeat: keeps intermediaries from idling out the
      // connection; ignored by EventSource (nit - low impact, but free).
      const heartbeat = setInterval(() => {
        try { controller.enqueue(encoder.encode(': ping\n\n')); } catch { /* closed */ }
      }, 30_000);

      ws.on('error', (err) => {
        clearInterval(heartbeat);
        send({ type: 'error', message: err.message });
        try { controller.close(); } catch { /* already closed */ }
      });

      ws.on('close', () => {
        clearInterval(heartbeat);
        try { controller.close(); } catch { /* already closed */ }
      });

      // Clean up when the browser disconnects
      request.signal.addEventListener('abort', () => {
        clearInterval(heartbeat);
        ws.close();
        try { controller.close(); } catch { /* already closed */ }
      });
    },
  });

  return new Response(body, {
    headers: {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
      'X-Accel-Buffering': 'no', // disable nginx buffering if behind a proxy
    },
  });
};
