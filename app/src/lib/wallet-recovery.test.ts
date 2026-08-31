import { describe, it, expect, vi } from 'vitest';
import { recoverThenSwapWallet, type WalletRecoveryDeps } from '@/lib/wallet-recovery';

function makeDeps(overrides: Partial<WalletRecoveryDeps> = {}): WalletRecoveryDeps & {
  calls: string[];
} {
  const calls: string[] = [];
  const deps: WalletRecoveryDeps = {
    walletClose: vi.fn(async () => { calls.push('close'); }),
    recoverWallet: vi.fn(async (path: string) => { calls.push(`recover:${path}`); }),
    openWallet: vi.fn(async (path: string) => { calls.push(`open:${path}`); }),
    unlink: vi.fn(async (path: string) => { calls.push(`unlink:${path}`); }),
    rename: vi.fn(async (from: string, to: string) => { calls.push(`rename:${from}->${to}`); }),
    ...overrides,
  };
  return Object.assign(deps, { calls });
}

const OPTS = {
  rpcPath: '/home/mintlayer/mintlayer.wallet',
  localPath: '/app/mintlayer-data/mintlayer.wallet',
  mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
};

describe('recoverThenSwapWallet (never destroy the wallet before recovery succeeds)', () => {
  it('recovers to a temp path, then swaps, then opens', async () => {
    const deps = makeDeps();
    await recoverThenSwapWallet(deps, OPTS);
    expect(deps.calls).toEqual([
      'close',
      `unlink:${OPTS.localPath}.recover`,
      `recover:${OPTS.rpcPath}.recover`,
      'close',
      `unlink:${OPTS.localPath}`,
      `rename:${OPTS.localPath}.recover->${OPTS.localPath}`,
      `open:${OPTS.rpcPath}`,
    ]);
  });

  it('does NOT unlink the existing wallet when the recovery scan fails', async () => {
    const deps = makeDeps({
      recoverWallet: vi.fn(async () => { throw new Error('daemon connection lost mid-scan'); }),
    });
    await expect(recoverThenSwapWallet(deps, OPTS)).rejects.toThrow('daemon connection lost mid-scan');
    const destructive = deps.calls.filter((c) => c.startsWith(`unlink:${OPTS.localPath}`) && !c.includes('.recover'));
    expect(destructive).toEqual([]);
    expect(deps.calls.some((c) => c.startsWith('rename:'))).toBe(false);
  });

  it('survives a failed initial close (wallet already closed)', async () => {
    const deps = makeDeps({
      walletClose: vi.fn()
        .mockRejectedValueOnce(new Error('no wallet is open'))
        .mockResolvedValueOnce(undefined),
    });
    await expect(recoverThenSwapWallet(deps, OPTS)).resolves.toBeUndefined();
    // The rejected close is swallowed; recovery and open still ran.
    // (mockRejectedValueOnce bypasses the recording impl, so only the
    // successful second close lands in the calls log.)
    expect(deps.calls).toContain(`recover:${OPTS.rpcPath}.recover`);
    expect(deps.calls).toContain(`open:${OPTS.rpcPath}`);
    expect(deps.calls).not.toContain(`unlink:${OPTS.localPath}.recover->x`);
  });

  it('ignores a missing stale temp file before recovering', async () => {
    const deps = makeDeps();
    // First unlink call is the stale-temp pre-clean: simulate ENOENT
    (deps.unlink as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      throw new Error('ENOENT');
    });
    await expect(recoverThenSwapWallet(deps, OPTS)).resolves.toBeUndefined();
    expect(deps.calls).toContain(`recover:${OPTS.rpcPath}.recover`);
    expect(deps.calls).toContain(`open:${OPTS.rpcPath}`);
  });

  it('leaves the old file in place if the final rename fails (old file already gone, temp preserved)', async () => {
    const deps = makeDeps({
      rename: vi.fn(async () => { throw new Error('EXDEV: cross-device link'); }),
    });
    await expect(recoverThenSwapWallet(deps, OPTS)).rejects.toThrow('EXDEV');
    // Recovery DID complete, so the destructive order was still correct:
    expect(deps.calls).toContain(`recover:${OPTS.rpcPath}.recover`);
  });
});
