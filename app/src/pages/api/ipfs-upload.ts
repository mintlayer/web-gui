/**
 * /api/ipfs-upload — Server-side proxy to IPFS pinning services.
 *
 * Supported providers (set IPFS_PROVIDER in .env):
 *   filebase — 5 GB free, always public  (FILEBASE_TOKEN)
 *              Bucket-specific API key from https://console.filebase.com/keys (scroll to bottom)
 *   pinata   — requires paid plan for public files  (PINATA_JWT)
 *
 * Backward compatibility: if IPFS_PROVIDER is unset but PINATA_JWT is present,
 * Pinata is used automatically.
 *
 * Returns 503 if no provider is configured.
 */

import type { APIRoute } from 'astro';

const provider = process.env.IPFS_PROVIDER ?? '';
// Backward compat: no IPFS_PROVIDER but PINATA_JWT present → treat as pinata
const effectiveProvider = provider || (process.env.PINATA_JWT ? 'pinata' : '');

export const POST: APIRoute = async ({ request }) => {
  if (!effectiveProvider) {
    return json({ ok: false, error: { message: 'IPFS upload not configured (IPFS_PROVIDER not set)' } }, 503);
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return json({ ok: false, error: { message: 'Invalid multipart form data' } }, 400);
  }

  const file = formData.get('file');
  if (!file || !(file instanceof File)) {
    return json({ ok: false, error: { message: 'Missing file field' } }, 400);
  }

  switch (effectiveProvider) {
    case 'filebase':
      return uploadToFilebase(file, process.env.FILEBASE_TOKEN ?? '');
    case 'pinata':
      return uploadToPinata(file, process.env.PINATA_JWT ?? '');
    default:
      return json({ ok: false, error: { message: `Unknown IPFS provider: ${effectiveProvider}` } }, 503);
  }
};

// ── Filebase (IPFS RPC API) ───────────────────────────────────────────────────

async function uploadToFilebase(file: File, token: string): Promise<Response> {
  if (!token) return json({ ok: false, error: { message: 'FILEBASE_TOKEN not set' } }, 503);

  const form = new FormData();
  form.append('file', file, file.name);

  let res: Response;
  try {
    res = await fetch('https://rpc.filebase.io/api/v0/add', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
  } catch (err) {
    return json({ ok: false, error: { message: `Filebase unreachable: ${String(err)}` } }, 502);
  }

  let data: { Name?: string; Hash?: string; Size?: string; Message?: string };
  try {
    data = await res.json();
  } catch (err) {
    return json({ ok: false, error: { message: `Failed to read Filebase response: ${String(err)}` } }, 502);
  }

  console.log(`[ipfs-upload] Filebase status=${res.status} hash=${data.Hash}`);

  if (!res.ok) {
    return json({ ok: false, error: { message: data.Message ?? `Filebase error ${res.status}` } }, 502);
  }

  const cid = data.Hash;
  if (!cid) {
    return json({ ok: false, error: { message: 'Filebase returned no CID' } }, 502);
  }

  return json({ ok: true, cid, url: `ipfs://${cid}` }, 200);
}

// ── Pinata ────────────────────────────────────────────────────────────────────

async function uploadToPinata(file: File, jwt: string): Promise<Response> {
  if (!jwt) return json({ ok: false, error: { message: 'PINATA_JWT not set' } }, 503);

  const pinataForm = new FormData();
  pinataForm.append('file', file, file.name);
  pinataForm.append('name', file.name);
  pinataForm.append('network', 'public');

  let pinataRes: Response;
  try {
    pinataRes = await fetch('https://uploads.pinata.cloud/v3/files', {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}` },
      body: pinataForm,
    });
  } catch (err) {
    return json({ ok: false, error: { message: `Pinata unreachable: ${String(err)}` } }, 502);
  }

  let rawBody: string;
  try {
    rawBody = await pinataRes.text();
  } catch (err) {
    return json({ ok: false, error: { message: `Failed to read Pinata response: ${String(err)}` } }, 502);
  }

  console.log(`[ipfs-upload] Pinata status=${pinataRes.status} body=${rawBody}`);

  let data: { data?: { cid: string }; error?: string };
  try {
    data = JSON.parse(rawBody);
  } catch {
    return json({ ok: false, error: { message: `Pinata returned non-JSON (status ${pinataRes.status}): ${rawBody.slice(0, 200)}` } }, 502);
  }

  if (!pinataRes.ok) {
    const msg = data.error ?? `Pinata error ${pinataRes.status}`;
    return json({ ok: false, error: { message: msg } }, 502);
  }

  const cid = data.data?.cid;
  if (!cid) {
    return json({ ok: false, error: { message: `Pinata returned no CID: ${rawBody.slice(0, 500)}` } }, 502);
  }

  return json({ ok: true, cid, url: `ipfs://${cid}` }, 200);
}

// ── Shared ────────────────────────────────────────────────────────────────────

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
