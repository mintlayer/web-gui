/**
 * Tests for the shared browser-side /api/rpc proxy helper.
 * fetch is stubbed so no MSW handler or real network is involved.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { rpc } from '@/lib/client-rpc';

const mockFetch = vi.fn<typeof fetch>();

afterEach(() => {
  mockFetch.mockReset();
  vi.unstubAllGlobals();
});

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('rpc', () => {
  it('POSTs the method and params to /api/rpc and returns the result', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true, result: { blocks: 123 } }));
    vi.stubGlobal('fetch', mockFetch);

    const result = await rpc<{ blocks: number }>('get_blockchain_info', { verbose: true });

    expect(result).toEqual({ blocks: 123 });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith('/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'get_blockchain_info', params: { verbose: true } }),
    });
  });

  it('defaults params to an empty object', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true, result: null }));
    vi.stubGlobal('fetch', mockFetch);

    await rpc('get_height');

    expect(mockFetch).toHaveBeenCalledWith('/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'get_height', params: {} }),
    });
  });

  it('surfaces the RPC error message when the call fails', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ ok: false, error: { message: 'method not found' } }),
    );
    vi.stubGlobal('fetch', mockFetch);

    await expect(rpc('no_such_method')).rejects.toThrow('method not found');
  });

  it('falls back to the generic "RPC error" message when no error object is present', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: false }));
    vi.stubGlobal('fetch', mockFetch);

    await expect(rpc('no_such_method')).rejects.toThrow('RPC error');
  });
});
