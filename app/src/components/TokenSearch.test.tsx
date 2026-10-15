// @vitest-environment jsdom
/** Tests for the verified-token bulk import section in TokenSearch. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TokenSearch from './TokenSearch';

vi.mock('@/lib/client-rpc', () => ({
  rpc: vi.fn().mockResolvedValue([]),
}));

const verifiedRows = {
  ok: true,
  tokens: [
    {
      tokenId: 'tmlaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1',
      ticker: 'AAA',
      displayName: 'Alpha Token',
      categories: ['defi'],
      circulatingSupply: '1,000',
      decimals: 18,
    },
    {
      tokenId: 'tmlbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2',
      ticker: 'BBB',
      displayName: 'Beta Token',
      categories: [],
      circulatingSupply: '2,000',
      decimals: 8,
    },
  ],
};

const fetchMock = vi.fn();

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url === '/api/indexer-status') return Promise.resolve(jsonResponse({ up: true }));
    if (url === '/api/explorer-tokens') return Promise.resolve(jsonResponse(verifiedRows));
    if (url === '/api/prefs') {
      if (init?.method === 'POST') return Promise.resolve(jsonResponse({ ok: true }));
      return Promise.resolve(jsonResponse({ ok: true, value: [] }));
    }
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  });
  vi.stubGlobal('fetch', fetchMock);
});

describe('TokenSearch verified-token import', () => {
  it('loads the verified list and imports the selection into favourites', async () => {
    const user = userEvent.setup();
    render(<TokenSearch network="mainnet" />);

    await user.click(screen.getByRole('button', { name: 'Browse verified tokens' }));
    expect(await screen.findByText('Alpha Token')).toBeInTheDocument();
    expect(screen.getByText('Beta Token')).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: /select all/i }));
    await user.click(screen.getByRole('button', { name: /import selected \(2\)/i }));

    expect(await screen.findByText(/Imported 2 tokens\./)).toBeInTheDocument();

    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(post).toBeDefined();
    const body = JSON.parse(String((post?.[1] as RequestInit).body)) as Array<Record<string, string>>;
    expect(body.map((e) => e.ticker)).toEqual(['AAA', 'BBB']);
    expect(body[0]?.tokenId).toContain('aaaa');
  });

  it('reports the unavailability of the explorer list', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/indexer-status') return Promise.resolve(jsonResponse({ up: true }));
      if (url === '/api/explorer-tokens') {
        return Promise.resolve(jsonResponse({ ok: false, error: 'Token list is unavailable' }));
      }
      if (url === '/api/prefs') return Promise.resolve(jsonResponse({ ok: true, value: [] }));
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    });

    render(<TokenSearch network="mainnet" />);
    await user.click(screen.getByRole('button', { name: 'Browse verified tokens' }));
    expect(await screen.findByText('Token list is unavailable')).toBeInTheDocument();
  });
});
