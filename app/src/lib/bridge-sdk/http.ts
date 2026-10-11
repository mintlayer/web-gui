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
  const { method = 'GET', body, headers = {} } = options;

  const init: RequestInit = {
    method,
    headers: body !== undefined
      ? { 'Content-Type': 'application/json', ...headers }
      : headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
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

  return (await response.json()) as T;
}

/**
 * Performs an HTTP request and returns the raw response text (used by
 * legacy callers that parse lazily).
 */
export async function apiRequestText(
  url: string,
  options: RequestOptions = {},
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const { method = 'GET', body, headers = {} } = options;

  const init: RequestInit = {
    method,
    headers: body !== undefined
      ? { 'Content-Type': 'application/json', ...headers }
      : headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };

  const response = await fetchImpl(url, init);

  if (!response.ok) {
    throw new BridgeSdkError(
      await extractErrorMessage(response),
      response.status,
    );
  }

  return response.text();
}
