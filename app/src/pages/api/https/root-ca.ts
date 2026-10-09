import type { APIRoute } from 'astro';
import { ROOT_CA_PATH, DOWNLOAD_FILENAME } from '@/lib/https-ca';

/**
 * Serves the root certificate of Caddy's local Certificate Authority so
 * users can import it on their devices and lose the browser warning.
 *
 * The caddy container exports just the public root.crt into the ca-public
 * volume (its PKI directory also holds the CA private keys, which never
 * leave the caddy container). Mounted read-only at /certs in web-gui; 404
 * until caddy has started at least once.
 *
 * Auth is enforced by the global session middleware — no public exposure.
 */

export const GET: APIRoute = async () => {
  const { readFile } = await import('node:fs/promises');
  let data: Buffer;
  try {
    data = await readFile(ROOT_CA_PATH);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return new Response(
        JSON.stringify({
          ok: false,
          error:
            'Local CA root not found. Start the HTTPS gateway first: docker compose --profile web up -d',
        }),
        { status: 404, headers: { 'Content-Type': 'application/json' } },
      );
    }
    // Broken mount or permissions — log it, don't pretend the CA is missing.
    console.error('[https] failed to read local CA root:', err);
    return new Response(
      JSON.stringify({ ok: false, error: 'Failed to read the local CA root (see server logs).' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // x-x509-ca-cert so OS/browser download flows recognize it as a CA cert.
  return new Response(new Uint8Array(data), {
    status: 200,
    headers: {
      'Content-Type': 'application/x-x509-ca-cert',
      'Content-Disposition': `attachment; filename="${DOWNLOAD_FILENAME}"`,
      'Content-Length': String(data.length),
      'Cache-Control': 'no-store',
    },
  });
};
