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

export const GET: APIRoute = async ({ request }) => {
  // Auth check - browsers send cookies with same-origin EventSource (per spec)
  const cookieHeader = request.headers.get('cookie') ?? '';
  const sessionToken =
    cookieHeader.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE_NAME}=([^;]+)`))?.[1] ?? '';
  if (!verifySessionToken(sessionToken)) {
    return new Response('Unauthorized', { status: 401 });
  }

  const rpcUrl    = process.env.WALLET_RPC_URL ?? 'http://wallet-rpc-daemon:3034';
  const username  = process.env.WALLET_RPC_USERNAME ?? '';
  const password  = process.env.WALLET_RPC_PASSWORD ?? '';

  // Convert http(s) → ws(s)
  const wsUrl = rpcUrl.replace(/^http/, 'ws');
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

      ws.on('error', (err) => {
        send({ type: 'error', message: err.message });
        try { controller.close(); } catch { /* already closed */ }
      });

      ws.on('close', () => {
        try { controller.close(); } catch { /* already closed */ }
      });

      // Clean up when the browser disconnects
      request.signal.addEventListener('abort', () => {
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
