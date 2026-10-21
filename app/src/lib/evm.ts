/**
 * EVM (MetaMask / EIP-1193) helpers for the Mintlayer bridge.
 *
 * Talks to `window.ethereum` directly (MetaMask only, per design) and wraps
 * the ERC20 / MintlayerBridge interactions needed for E2M deposits:
 *   approve(spender, amount) -> deposit(token, amount, mintlayerAddress)
 *
 * Amounts are handled as token-unit decimal strings; conversion to wei is
 * done with ethers.parseUnits using the token's decimals from the bridge
 * config (all bridged ERC20s are 18-decimal).
 */
import { BrowserProvider, Contract, formatUnits, parseUnits } from 'ethers';

// Re-exported for components that must stay in integer base-unit land.
export { formatUnits, parseUnits };

export const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function decimals() view returns (uint8)',
];

export const BRIDGE_DEPOSIT_ABI = [
  {
    inputs: [
      { internalType: 'address', name: 'token', type: 'address' },
      { internalType: 'uint256', name: 'amount', type: 'uint256' },
      { internalType: 'string', name: 'mintlayerAddress', type: 'string' },
    ],
    name: 'deposit',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
];

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] | object }) => Promise<unknown>;
      on?: (event: string, handler: (...args: unknown[]) => void) => void;
      removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
      isMetaMask?: boolean;
    };
  }
}

export class EvmError extends Error {
  readonly code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.name = 'EvmError';
    this.code = code;
  }
}

/**
 * Normalize a wallet/contract rejection into an EvmError with a stable code:
 * - 4001 / ACTION_REJECTED → user rejected (info, not error - the user chose
 *   to cancel and the UI should treat it as such)
 * - -32002 → a request for the same confirmation is already pending in the
 *   wallet (user should open the wallet extension)
 * Everything else keeps its raw code/message so unexpected failures still
 * surface verbatim.
 */
export function normalizeEvmRejection(err: unknown): EvmError {
  const e = err as { code?: number | string; message?: string };
  const code = typeof e?.code === 'number' ? e.code : undefined;
  const message = e?.message ?? String(err);
  if (code === 4001 || /ACTION_REJECTED|user rejected/i.test(message)) {
    return new EvmError('Request rejected in your wallet.', 4001);
  }
  if (code === -32002 || /already pending/i.test(message)) {
    return new EvmError(
      'A request is already waiting in your wallet - open the wallet extension to approve or reject it.',
      -32002,
    );
  }
  return new EvmError(message, code);
}

export function hasEthereumProvider(): boolean {
  return typeof window !== 'undefined' && !!window.ethereum;
}

/** Typed accessor for the guarded provider (call after hasEthereumProvider()). */
function eth(): NonNullable<Window['ethereum']> {
  if (!hasEthereumProvider()) {
    throw new EvmError('MetaMask not installed');
  }
  return window.ethereum!;
}

function provider(): BrowserProvider {
  return new BrowserProvider(eth());
}

/** Prompt MetaMask for account access. Returns the selected address. */
export async function connectMetaMask(): Promise<string> {
  const accounts = (await eth().request({
    method: 'eth_requestAccounts',
  })) as string[];
  if (!accounts?.length) throw new EvmError('No accounts authorized');
  return accounts[0];
}

export async function getConnectedAccount(): Promise<string | null> {
  if (!hasEthereumProvider()) return null;
  try {
    const accounts = (await window.ethereum!.request({
      method: 'eth_accounts',
    })) as string[];
    return accounts?.[0] ?? null;
  } catch {
    return null;
  }
}

/** Switch MetaMask to the given chain, adding it if unknown. */
export async function switchChain(
  chainIdHex: string,
  chainParams?: Record<string, unknown>,
): Promise<void> {
  try {
    await eth().request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: chainIdHex }],
    });
  } catch (err) {
    const code = (err as { code?: number }).code;
    const msg = (err as { message?: string }).message ?? '';
    // 4902 = chain not added to the wallet; some MetaMask versions
    // (mobile especially) report -32603 "Unrecognized chain" instead.
    const missing = code === 4902 || (code === -32603 && /unrecognized chain/i.test(msg));
    if (missing && chainParams) {
      await eth().request({
        method: 'wallet_addEthereumChain',
        params: [{ chainId: chainIdHex, ...chainParams }],
      });
    } else {
      throw err;
    }
  }
}

/** ERC20 token balance formatted in token units. */
export async function getTokenBalance(
  tokenAddress: string,
  userAddress: string,
): Promise<string> {
  const b = await getTokenBalanceBase(tokenAddress, userAddress);
  return formatUnits(b.raw, b.decimals);
}

/** Balance as exact base units + the token's own decimals: callers doing
 * arithmetic (fraction buttons, caps) must not go through float strings -
 * at 18 decimals 2^53 is only ~0.009 tokens and rounding lands above the
 * real balance. */
export async function getTokenBalanceBase(
  tokenAddress: string,
  userAddress: string,
): Promise<{ raw: bigint; decimals: number }> {
  const p = provider();
  const token = new Contract(tokenAddress, ERC20_ABI, p);
  // Read the decimals from the token itself: assuming 18 shows USDC/USDT
  // (6 decimals) balances 10^12x too small and breaks the Max buttons.
  const decimals = Number(await token.decimals());
  const raw = (await token.balanceOf(userAddress)) as bigint;
  return { raw, decimals };
}

/**
 * E2M deposit: approve the bridge contract, then call
 * deposit(token, amountWei, mintlayerAddress). Returns the deposit tx hash.
 * `onProgress` reports UX phase changes (approve / deposit).
 */
export async function depositToBridge(
  bridgeContractAddress: string,
  tokenAddress: string,
  amount: string,
  decimals: number,
  mintlayerAddress: string,
  onProgress?: (phase: 'approve' | 'deposit') => void,
  expectedChainId?: number,
): Promise<string> {
  if (!bridgeContractAddress) {
    throw new Error('Bridge contract address is not configured.');
  }
  const p = provider();
  const signer = await p.getSigner();

  // Signing happens against whatever chain the wallet currently has
  // active (another tab or a mobile app can switch it): verify right
  // before the money moves. A codeless address on the wrong chain would
  // otherwise "mine" a deposit that never exists.
  if (typeof expectedChainId === 'number') {
    const { chainId } = await p.getNetwork();
    if (chainId !== BigInt(expectedChainId)) {
      throw new EvmError(
        'Your wallet switched to a different network. Switch back to the bridge network and try again.',
      );
    }
  }

  const token = new Contract(tokenAddress, ERC20_ABI, signer);
  // The chain is the source of truth for decimals - many bridgeable
  // tokens (USDC et al.) are not 18, and the config carries no value.
  // ethers v6 decodes uint8 returns as bigint: convert before the
  // integer check or the guard rejects every honest answer.
  let resolvedDecimals = decimals;
  try {
    const n = Number(await token.decimals());
    if (Number.isInteger(n) && n >= 0 && n <= 36) {
      resolvedDecimals = n;
    }
  } catch {
    /* keep the caller-provided fallback */
  }
  const amountWei = parseUnits(amount, resolvedDecimals);

  // Skip the approve round-trip when the bridge already has enough
  // allowance for this deposit (reads can fail on some providers -
  // fall through to a fresh approve, the previous behaviour).
  let needsApproval = true;
  try {
    const bridge = new Contract(bridgeContractAddress, BRIDGE_DEPOSIT_ABI, signer);
    const owner = await signer.getAddress();
    const spender = await bridge.getAddress();
    const allowance = (await token.allowance(owner, spender)) as bigint;
    needsApproval = allowance < amountWei;
  } catch {
    needsApproval = true;
  }
  if (needsApproval) {
    onProgress?.('approve');
    try {
      const approveTx = await token.approve(bridgeContractAddress, amountWei);
      await approveTx.wait();
    } catch (err) {
      // USDT-class tokens revert on a non-zero -> non-zero approve; the
      // fix is a zero-reset first, then the real allowance.
      if (normalizeEvmRejection(err).code === 4001) throw err;
      const resetTx = await token.approve(bridgeContractAddress, 0);
      await resetTx.wait();
      const approveTx = await token.approve(bridgeContractAddress, amountWei);
      await approveTx.wait();
    }
  }

  // Re-verify the chain right before the deposit: the approve can mine
  // for minutes, and a chain switched during that window (other tab,
  // mobile push) must not carry the deposit.
  if (typeof expectedChainId === 'number') {
    const { chainId } = await p.getNetwork();
    if (chainId !== BigInt(expectedChainId)) {
      throw new EvmError(
        'Your wallet switched to a different network. Switch back to the bridge network and try again.',
      );
    }
  }

  const bridge = new Contract(bridgeContractAddress, BRIDGE_DEPOSIT_ABI, signer);
  onProgress?.('deposit');
  const depositTx = await bridge.deposit(tokenAddress, amountWei, mintlayerAddress);
  return depositTx.hash;
}
