import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from './link-seed';

/**
 * POST /api/bitcoin/link-seed — server-side seed reveal → sidecar.
 * Contract under test: gates (enabled, step-up, password), the
 * re-lock-in-finally guarantee, honest error mapping and the hard rule
 * that the seed phrase never appears in any response.
 */

vi.mock('@/lib/step-up', () => ({
  requireStepUp: vi.fn(() => ({ ok: true as const })),
  totpFromBody: vi.fn(() => '123456'),
}));

const lockPrivateKeys = vi.fn();
const unlockPrivateKeys = vi.fn();
const showSeedPhrase = vi.fn();
const createFromSeed = vi.fn();

vi.mock('@/lib/wallet-rpc', () => ({
  walletLockPrivateKeys: (...a: unknown[]) => lockPrivateKeys(...(a as [])),
  walletUnlockPrivateKeys: (...a: unknown[]) => unlockPrivateKeys(...(a as [])),
  walletShowSeedPhrase: (...a: unknown[]) => showSeedPhrase(...(a as [])),
  isWalletNotOpenError: (err: unknown) =>
    String((err as Error)?.message ?? '').includes('no wallet'),
}));

vi.mock('@/lib/bitcoin-wallet', () => ({
  isBitcoinEnabled: vi.fn(() => true),
  createBitcoinWalletFromSeedWithRetry: (...a: unknown[]) => createFromSeed(...(a as [])),
}));

function req(body: unknown): Parameters<typeof POST>[0] {
  return {
    request: new Request('http://x/api/bitcoin/link-seed', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    clientAddress: '127.0.0.1',
  } as Parameters<typeof POST>[0];
}

const SEED = ['abandon', 'abandon', 'abandon', 'abandon', 'abandon', 'abandon', 'abandon', 'abandon', 'abandon', 'abandon', 'abandon', 'about'];

describe('POST /api/bitcoin/link-seed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    unlockPrivateKeys.mockResolvedValue(undefined);
    lockPrivateKeys.mockResolvedValue(undefined);
    showSeedPhrase.mockResolvedValue({ seed_phrase: SEED, passphrase: null });
    createFromSeed.mockResolvedValue({ ok: true, created: true, network: 'mainnet' });
  });

  it('links: unlocks, reveals, derives the wallet, re-locks', async () => {
    const res = await POST(req({ password: 'hunter2', totp_code: '123456' }));
    expect(res.status).toBe(200);
    const passed = createFromSeed.mock.calls[0]?.[0] as string;
    expect(passed).toBe(SEED.join(' '));
    expect(lockPrivateKeys).toHaveBeenCalledTimes(1);
    // Re-lock happens as soon as the seed is extracted — before the
    // sidecar call — keeping the unlocked window minimal.
    expect(lockPrivateKeys.mock.invocationCallOrder[0]).toBeGreaterThan(
      showSeedPhrase.mock.invocationCallOrder[0],
    );
  });

  it('never echoes the seed phrase in the response', async () => {
    const res = await POST(req({ password: 'hunter2', totp_code: '123456' }));
    const text = JSON.stringify(await res.json());
    for (const word of SEED) {
      expect(text).not.toContain(word);
    }
  });

  it('re-locks even when the reveal fails', async () => {
    showSeedPhrase.mockRejectedValue(new Error('private keys are locked'));
    const res = await POST(req({ password: 'hunter2', totp_code: '123456' }));
    expect(res.status).toBe(403);
    expect(lockPrivateKeys).toHaveBeenCalledTimes(1);
  });

  it('re-locks even when the sidecar call fails', async () => {
    createFromSeed.mockRejectedValue(
      Object.assign(new Error('BTC wallet service unreachable'), { status: 503 }),
    );
    const res = await POST(req({ password: 'hunter2', totp_code: '123456' }));
    expect(res.status).toBe(503);
    expect(lockPrivateKeys).toHaveBeenCalledTimes(1);
  });

  it('maps a wrong password to 403 and never reaches the reveal', async () => {
    unlockPrivateKeys.mockRejectedValue(new Error('Invalid password or passphrase'));
    await POST(req({ password: 'nope', totp_code: '123456' }));
    expect(showSeedPhrase).not.toHaveBeenCalled();
  });

  it('maps a locked reveal to 403 and a closed wallet to 409', async () => {
    showSeedPhrase.mockRejectedValue(new Error('wallet private keys are locked'));
    expect((await POST(req({ password: 'p', totp_code: '123456' }))).status).toBe(403);

    showSeedPhrase.mockRejectedValue(new Error('no wallet is open'));
    expect((await POST(req({ password: 'p', totp_code: '123456' }))).status).toBe(409);
  });

  it('maps a missing/empty seed to 409', async () => {
    showSeedPhrase.mockResolvedValue({ seed_phrase: [], passphrase: null });
    expect((await POST(req({ password: 'p', totp_code: '123456' }))).status).toBe(409);
  });

  it('requires a password', async () => {
    expect((await POST(req({ totp_code: '123456' }))).status).toBe(400);
    expect(unlockPrivateKeys).not.toHaveBeenCalled();
  });

  it('rejects a broken body', async () => {
    const res = await POST(req(undefined));
    expect(res.status).toBe(400);
  });
});
