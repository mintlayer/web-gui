import type { APIRoute } from 'astro';
import { join } from 'node:path';

const WALLET_FILENAME = 'mintlayer.wallet';
const dataDir = process.env.MINTLAYER_DATA_DIR ?? '/app/mintlayer-data';
const LOCAL_PATH = join(dataDir, WALLET_FILENAME);

export const GET: APIRoute = async () => {
  const { readFile } = await import('node:fs/promises');
  let data: Buffer;
  try {
    data = await readFile(LOCAL_PATH);
  } catch {
    return new Response('Wallet file not found or not readable.', { status: 404 });
  }

  return new Response(new Uint8Array(data), {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${WALLET_FILENAME}.backup"`,
      'Content-Length': String(data.length),
      'Cache-Control': 'no-store',
    },
  });
};
