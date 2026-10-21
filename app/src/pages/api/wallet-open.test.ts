import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/wallet-rpc', () => ({
  walletInfo: vi.fn(),
  ensureWalletOpen: vi.fn(),
  isWalletNotOpenError: vi.fn(),
  // Real class shape so browserSafeOpenError can read `.code` on thrown values.
  WalletRpcError: class WalletRpcError extends Error {
    constructor(message: string, public readonly code: number) {
      super(message);
      this.name = 'WalletRpcError';
    }
  },
}));

import { POST } from '@/pages/api/wallet-open';
import { walletInfo, ensureWalletOpen, isWalletNotOpenError } from '@/lib/wallet-rpc';

function makeCtx() {
  return {
    request: new Request('http://localhost/api/wallet-open', { method: 'POST' }),
  } as Parameters<typeof POST>[0];
}

beforeEach(() => {
  vi.mocked(walletInfo).mockReset();
  vi.mocked(ensureWalletOpen).mockReset();
  vi.mocked(isWalletNotOpenError).mockReset();
});

describe('POST /api/wallet-open', () => {
  it('returns already_open when wallet is already open', async () => {
    vi.mocked(walletInfo).mockResolvedValue({} as never);
    const res = await POST(makeCtx());
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, status: 'already_open' });
    expect(ensureWalletOpen).not.toHaveBeenCalled();
  });

  it('returns opened after successfully opening wallet', async () => {
    vi.mocked(walletInfo).mockRejectedValue(new Error('not open'));
    vi.mocked(isWalletNotOpenError).mockReturnValue(true);
    vi.mocked(ensureWalletOpen).mockResolvedValue({ status: 'ok' } as never);
    const res = await POST(makeCtx());
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, status: 'opened' });
  });

  it('returns needs_password when wallet is encrypted', async () => {
    vi.mocked(walletInfo).mockRejectedValue(new Error('not open'));
    vi.mocked(isWalletNotOpenError).mockReturnValue(true);
    vi.mocked(ensureWalletOpen).mockResolvedValue({ status: 'needs_password' } as never);
    const res = await POST(makeCtx());
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, status: 'needs_password' });
  });

  it('returns not_found when wallet file does not exist', async () => {
    vi.mocked(walletInfo).mockRejectedValue(new Error('not open'));
    vi.mocked(isWalletNotOpenError).mockReturnValue(true);
    vi.mocked(ensureWalletOpen).mockResolvedValue({ status: 'not_found' } as never);
    const res = await POST(makeCtx());
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, status: 'not_found' });
  });

  it('returns error when ensureWalletOpen fails unexpectedly', async () => {
    vi.mocked(walletInfo).mockRejectedValue(new Error('not open'));
    vi.mocked(isWalletNotOpenError).mockReturnValue(true);
    // A transport-band WalletRpcError (-32000) must surface as the generic
    // copy - the raw message carries the daemon URL.
    const { WalletRpcError } = await import('@/lib/wallet-rpc');
    vi.mocked(ensureWalletOpen).mockResolvedValue({
      status: 'error',
      message: 'Cannot reach wallet-rpc-daemon at http://localhost:3034: boom',
      error: new WalletRpcError('Cannot reach wallet-rpc-daemon at http://localhost:3034: boom', -32000),
    } as never);
    const res = await POST(makeCtx());
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, status: 'error' });
    expect(body.message).not.toContain('3034');
    expect(body.message).toMatch(/unavailable/);
  });

  it('surfaces error when walletInfo throws a non-wallet error', async () => {
    vi.mocked(walletInfo).mockRejectedValue(new Error('daemon unreachable'));
    vi.mocked(isWalletNotOpenError).mockReturnValue(false);
    const res = await POST(makeCtx());
    const body = await res.json();
    // Redacted: the raw pre-check error must not reach the browser.
    expect(body).toMatchObject({ ok: false, status: 'error' });
    expect(body.message).not.toContain('daemon unreachable');
    expect(body.message).toMatch(/unavailable/);
    expect(ensureWalletOpen).not.toHaveBeenCalled();
  });

  it('forwards application-band rpc errors verbatim', async () => {
    vi.mocked(walletInfo).mockRejectedValue(new Error('not open'));
    vi.mocked(isWalletNotOpenError).mockReturnValue(true);
    const { WalletRpcError } = await import('@/lib/wallet-rpc');
    vi.mocked(ensureWalletOpen).mockResolvedValue({
      status: 'error',
      message: 'wallet file is corrupted',
      error: new WalletRpcError('wallet file is corrupted', -1),
    } as never);
    const res = await POST(makeCtx());
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, status: 'error', message: 'wallet file is corrupted' });
  });
});
