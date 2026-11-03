export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export type HttpMethod = 'GET' | 'POST';

export interface RequestOptions {
  method?: HttpMethod;
  /** JSON-serializable request body. */
  body?: unknown;
  headers?: Record<string, string>;
  /** Abort budget in ms. Defaults to 10s; endpoints that make the SERVER
   *  perform an on-chain action (e.g. broadcastBridgeRequest) need more -
   *  aborting a slow-but-successful broadcast desyncs client belief from
   *  chain state and invites a double deposit on retry. */
  timeoutMs?: number;
}

/** Error thrown by bridge-sdk requests; carries the HTTP status when known. */
export class BridgeSdkError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'BridgeSdkError';
    this.status = status;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null;

async function extractErrorMessage(response: Response): Promise<string> {
  try {
    const data = await response.json();
    if (isRecord(data) && typeof data.error === 'string') return data.error;
    return JSON.stringify(data);
  } catch {
    return `Request failed with status: ${response.status}`;
  }
}

/**
 * Performs an HTTP request against a bridge/api-server endpoint and returns
 * the parsed JSON body. The fetch implementation is injectable for tests.
 */
export async function apiRequest<T>(
  url: string,
  options: RequestOptions = {},
  fetchImpl: FetchLike = fetch,
): Promise<T> {
  const { method = 'GET', body, headers = {}, timeoutMs = 10_000 } = options;

  const init: RequestInit = {
    method,
    headers: body !== undefined
      ? { 'Content-Type': 'application/json', ...headers }
      : headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    // Bounded so a hung bridge host cannot pin a poll forever: uncounted
    // pending fetches never trip the panel's failure backoff and pile up
    // until the browser's per-host connection pool starves.
    signal: AbortSignal.timeout(timeoutMs),
  };

  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (cause) {
    throw new BridgeSdkError(
      `Network error while calling ${url}: ${String(cause)}`,
    );
  }

  if (!response.ok) {
    throw new BridgeSdkError(
      await extractErrorMessage(response),
      response.status,
    );
  }

  try {
    return (await response.json()) as T;
  } catch {
    // 2xx with a non-JSON body (proxy interstitial, empty gateway reply):
    // surface a typed error instead of a raw SyntaxError.
    throw new BridgeSdkError(
      `Invalid JSON response from ${url} (status ${response.status})`,
      response.status,
    );
  }
}
