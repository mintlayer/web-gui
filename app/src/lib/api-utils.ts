/**
 * Shared helpers for API routes (`src/pages/api/**`).
 */

/** Serialize a JSON body into a `Response` with the JSON content type. */
export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      // Authenticated/money-path responses must never land in the browser
      // cache (shared-machine risk). Deliberately NOT caller-overridable.
      ...headers,
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

/** Parse the request body as multipart form data; returns null when parsing fails. */
export async function readFormData(request: Request): Promise<FormData | null> {
  try {
    return await request.formData();
  } catch {
    return null;
  }
}

/** Pre-parse body caps for the public POST endpoints: request.formData()
 * / request.json() buffer the entire body before any validation, so a
 * multi-GB POST to an unauthenticated route can exhaust container memory.
 */
export const LOGIN_BODY_LIMIT = 1 << 20; // 1 MiB: password + TOTP + passkey blobs
export const UPLOAD_BODY_LIMIT = 55 << 20; // covers the 50 MB wallet-file cap
export const PASSKEY_BODY_LIMIT = 64 << 10; // 64 KiB: WebAuthn client data

async function bufferedWithin(request: Request, maxBytes: number): Promise<Request | null> {
  const len = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(len) && len > 0) return len > maxBytes ? null : request;
  // No content-length (chunked): read with a hard cap and re-parse the
  // buffer so the raw stream can never outgrow the limit.
  const reader = request.body?.getReader();
  if (!reader) return request;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* already gone */ }
      return null;
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { merged.set(c, off); off += c.byteLength; }
  const headers = new Headers(request.headers);
  headers.delete('content-length');
  headers.delete('transfer-encoding');
  return new Request(request.url, { method: request.method, headers, body: merged });
}

/** Parsed form body, or null when malformed OR over the byte cap. */
export async function readFormWithinLimit(request: Request, maxBytes: number): Promise<FormData | null> {
  const bounded = await bufferedWithin(request, maxBytes);
  if (!bounded) return null;
  return readFormData(bounded);
}

/** Parsed JSON body, or null when malformed OR over the byte cap. */
export async function readJsonWithinLimit<T = unknown>(request: Request, maxBytes: number): Promise<T | null> {
  const bounded = await bufferedWithin(request, maxBytes);
  if (!bounded) return null;
  try {
    return (await bounded.json()) as T;
  } catch {
    return null;
  }
}
