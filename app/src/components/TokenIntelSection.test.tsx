import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import TokenIntelSection from './TokenIntelSection';

function intelBody() {
  return {
    ok: true,
    statistics: {
      circulating_supply: { atoms: '1000000000', decimal: '10' },
      preminted: { atoms: '100000000', decimal: '1' },
      burned: { atoms: '50000000', decimal: '0.5' },
      staked: { atoms: '200000000', decimal: '2' },
    },
    holders: [
      { address: 'mt1qlongaddress0000000000000000000001', amount: { atoms: '400000000', decimal: '4' } },
      { address: 'mt1qshort', amount: { atoms: '100000000', decimal: '1' } },
    ],
    moreHolders: true,
  };
}

describe('TokenIntelSection', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('stays collapsed and does not fetch until expanded', () => {
    render(<TokenIntelSection tokenId="tml_1" ticker="TST" />);
    expect(screen.getByText(/Supply statistics & holders/i)).toBeDefined();
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.queryByText('Top holders')).toBeNull();
  });

  it('loads and renders statistics and shortened holder addresses on expand', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify(intelBody()), { status: 200 }),
    );
    render(<TokenIntelSection tokenId="tml_1" ticker="TST" />);

    fireEvent.click(screen.getByText(/Supply statistics & holders/i));

    await waitFor(() => expect(screen.getByText('Top holders')).toBeDefined());
    expect(screen.getByText('10 TST')).toBeDefined();
    expect(screen.getByText('0.5 TST')).toBeDefined();
    // Long address is shortened, short one is shown as-is (CopyButton sits
    // inside the same span, so match on a substring)
    expect(screen.getAllByText(/mt1qlongad…000001/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/mt1qshort/).length).toBeGreaterThan(0);
    // moreHolders -> explorer link
    expect(screen.getByText(/all holders on the explorer/i)).toBeDefined();
    const link = screen.getByText(/all holders on the explorer/i).closest('a');
    expect(link?.getAttribute('href')).toBe('https://explorer.mintlayer.org/token/tml_1');
  });

  it('shows the upgrade hint when the indexer is pre-1.4.1', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ ok: false, reason: 'requires-1.4.1' }), { status: 200 }),
    );
    render(<TokenIntelSection tokenId="tml_1" ticker="TST" />);
    fireEvent.click(screen.getByText(/Supply statistics & holders/i));

    await waitFor(() =>
      expect(screen.getByText(/need a v1.4.1 or newer indexer/i)).toBeDefined(),
    );
  });

  it('shows a friendly message when the indexer is unreachable', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ECONNREFUSED'));
    render(<TokenIntelSection tokenId="tml_1" ticker="TST" />);
    fireEvent.click(screen.getByText(/Supply statistics & holders/i));

    await waitFor(() =>
      expect(screen.getByText(/indexer is not reachable right now/i)).toBeDefined(),
    );
  });
});
