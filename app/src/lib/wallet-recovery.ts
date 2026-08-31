/**
 * Seed-import recovery with a safe swap order.
 *
 * The original flow unlinked the wallet file BEFORE the recovery scan, which
 * can run "many minutes" on mainnet - a crash or timeout mid-scan destroyed
 * the wallet with no way back. Here the recovery targets a temp path first;
 * the old wallet file is only removed after a successful scan, then the
 * recovered temp file is renamed into place.
 */
export interface WalletRecoveryDeps {
  walletClose(): Promise<unknown>;
  recoverWallet(path: string, mnemonic: string): Promise<unknown>;
  openWallet(path: string): Promise<unknown>;
  unlink(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

export interface RecoverThenSwapOptions {
  /** Wallet file path as the wallet-rpc-daemon sees it. */
  rpcPath: string;
  /** Wallet file path as seen from this process (bind mount of rpcPath). */
  localPath: string;
  mnemonic: string;
}

/**
 * Recover a wallet from a mnemonic without ever destroying the existing
 * wallet file before the recovery has succeeded.
 * Order: close → recover(temp) → close → unlink(old) → rename(temp→old) → open.
 */
export async function recoverThenSwapWallet(
  deps: WalletRecoveryDeps,
  opts: RecoverThenSwapOptions,
): Promise<void> {
  // 1. Close the currently open wallet (ignore error if already closed)
  try { await deps.walletClose(); } catch { /* already closed */ }

  const recoverLocalPath = opts.localPath + '.recover';
  const recoverRpcPath = opts.rpcPath + '.recover';

  // 2. Clear any stale temp file left by a previously failed recovery
  await deps.unlink(recoverLocalPath).catch(() => { /* no stale temp */ });

  // 3. Recover to the TEMP path - may scan for many minutes. The existing
  //    wallet file is untouched while this runs.
  await deps.recoverWallet(recoverRpcPath, opts.mnemonic);

  // 4. The daemon leaves the recovered temp wallet open - close before swap
  try { await deps.walletClose(); } catch { /* already closed */ }

  // 5. Swap: out with the old, in with the recovered temp
  await deps.unlink(opts.localPath);
  await deps.rename(recoverLocalPath, opts.localPath);

  // 6. Open the recovered wallet at its canonical path
  await deps.openWallet(opts.rpcPath);
}
