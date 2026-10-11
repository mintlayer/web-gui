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
