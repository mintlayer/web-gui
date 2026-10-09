import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createBridgeSdk, type BridgeSdk } from '@/lib/bridge-sdk';

const mockFetch = vi.fn<typeof fetch>();

beforeEach(() => {
  mockFetch.mockReset();
});

function makeSdk(): BridgeSdk {
  return createBridgeSdk({ fetchImpl: mockFetch as unknown as typeof fetch });
}

describe('bridge-sdk', () => {
  it('builds fees and config URLs from the api base', async () => {
    mockFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const sdk = makeSdk();
    await sdk.getFees();
    await sdk.getConfig();
    const urls = mockFetch.mock.calls.map((c) => c[0] as string);
    expect(urls[0]).toContain('/api/v1/fees');
    expect(urls[1]).toContain('/api/v1/agents-config');
  });

  it('broadcasts a bridge request via POST', async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({ bridge_request_uuid: 'u1', deposit_transaction_uuids: ['d1'] }),
        { status: 200 },
      ),
    );
    const sdk = makeSdk();
    const res = await sdk.broadcastBridgeRequest({
      source_chain: 'Mintlayer',
      destination_chain: 'Ethereum',
      asset: 'crv',
      amount: '1.5',
      receiver_address: '0xabc',
      deposit_transactions: [{ raw_transaction: 'ff', intent: 'aa' }],
    });
    expect(res.bridge_request_uuid).toBe('u1');
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string).deposit_transactions[0]).toEqual({
      raw_transaction: 'ff',
      intent: 'aa',
    });
  });

  it('escapes uuid path segments', async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ status: 'pending' }), { status: 200 }),
    );
    const sdk = makeSdk();
    await sdk.getBridgeRequest('a/b');
    expect((mockFetch.mock.calls[0][0] as string)).toContain('/bridge-request/a%2Fb');
  });

  it('throws BridgeSdkError with the API message on failure', async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: 'boom' }), { status: 422 }),
    );
    const sdk = makeSdk();
    await expect(sdk.getFees()).rejects.toThrow(/boom/);
  });

  it('listBridgeRequests serializes filters', async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200 }),
    );
    const sdk = makeSdk();
    await sdk.listBridgeRequests({ limit: 5, status: ['pending', 'completed'] });
    const url = decodeURIComponent(mockFetch.mock.calls[0][0] as string);
    expect(url).toContain('limit=5');
    expect(url).toContain('status=pending,completed');
  });
});
