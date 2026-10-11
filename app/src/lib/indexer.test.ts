import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getOrderBook,
  getTransactionInfo,
  isPendingIndexerTransaction,
  listMempoolTransactions,
  listTokenHolders,
  getFeerate,
  listIndexerPoolsByHeight,
  listTokenAuthorities,
} from './indexer';

const BASE = 'http://api-web-server:3000/api/v2';

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  const res = new Response(JSON.stringify(body), {
    status: 200,
    headers,
  });
  return res;
}

describe('1.4.1 indexer wrappers', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({})));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('getOrderBook requests the given side and page', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          items: [{ price: { decimal: '0.5', atoms: '1/2' }, amount: { decimal: '10', atoms: '10000000' } }],
          next_cursor: null,
        }),
      ),
    );
    const page = await getOrderBook('ML_tml_1', 'ask', { items: 20 });
    const url = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toBe(`${BASE}/order/pair/ML_tml_1/book?side=ask&items=20`);
    expect(page.items).toHaveLength(1);
    expect(page.next_cursor).toBeNull();
  });

  it('getOrderBook clamps items to 1..=100 and forwards the cursor', async () => {
    await getOrderBook('ML_tml_1', 'bid', { items: 500, cursor: 'abc' });
    const url = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toBe(`${BASE}/order/pair/ML_tml_1/book?side=bid&items=100&cursor=abc`);
  });

  it('listTokenHolders walks the cursor envelope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          items: [{ address: 'mt1qxyz', amount: { decimal: '5', atoms: '500000000' } }],
          next_cursor: 'c29tZQ',
        }),
      ),
    );
    const page = await listTokenHolders('tml_1', { cursor: 'prev', items: 10 });
    const url = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toBe(`${BASE}/statistics/token/tml_1/holders?items=10&cursor=prev`);
    expect(page.next_cursor).toBe('c29tZQ');
    expect(page.items[0].amount.atoms).toBe('500000000');
  });

  it('getTransactionInfo hits the transaction endpoint (mempool fallback server-side)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ id: 'tx1', block_id: null, timestamp: null, confirmations: null, inputs: [], outputs: [] }),
      ),
    );
    const info = await getTransactionInfo('tx1');
    const url = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toBe(`${BASE}/transaction/tx1`);
    expect(isPendingIndexerTransaction(info)).toBe(true);
  });

  it('isPendingIndexerTransaction is false once confirmations are known', () => {
    expect(
      isPendingIndexerTransaction({ block_id: 'b1', confirmations: 3 }),
    ).toBe(false);
    expect(isPendingIndexerTransaction({ block_id: 'b1', confirmations: null })).toBe(true);
  });

  it('listMempoolTransactions reads the x-mempool-ordering header', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(
          [{ id: 'tx2', block_id: null, timestamp: null, confirmations: null, inputs: [], outputs: [] }],
          { 'x-mempool-ordering': 'dependency' },
        ),
      ),
    );
    const listing = await listMempoolTransactions(0, 20, 'dependency');
    const url = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toBe(`${BASE}/mempool/transactions?offset=0&items=20&order=dependency`);
    expect(listing.ordering).toBe('dependency');
    expect(listing.transactions[0].id).toBe('tx2');
  });

  it('listMempoolTransactions defaults the ordering to insertion', async () => {
    const listing = await listMempoolTransactions();
    expect(listing.ordering).toBe('insertion');
  });

  it('getFeerate passes in_top_x_mb and returns the atoms-per-kB string', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse('1234')));
    const feerate = await getFeerate(2);
    const url = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toBe(`${BASE}/feerate?in_top_x_mb=2`);
    expect(feerate).toBe('1234');
  });

  it('listIndexerPoolsByHeight uses the keyset sort', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ items: [], next_cursor: null })),
    );
    await listIndexerPoolsByHeight({ cursor: 'c1', items: 25 });
    const url = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toBe(`${BASE}/pool?sort=by_height&items=25&cursor=c1`);
  });

  it('listTokenAuthorities returns the token id list', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(['tml_1', 'tml_2'])));
    const tokens = await listTokenAuthorities('mt1qxyz');
    const url = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toBe(`${BASE}/address/mt1qxyz/token-authority`);
    expect(tokens).toEqual(['tml_1', 'tml_2']);
  });
});
