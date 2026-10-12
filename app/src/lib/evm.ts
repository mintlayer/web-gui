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

export const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
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
 * - 4001 / ACTION_REJECTED → user rejected (info, not error — the user chose
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
      'A request is already waiting in your wallet — open the wallet extension to approve or reject it.',
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
    // 4902 = chain not added to the wallet
    if (code === 4902 && chainParams) {
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
  decimals = 18,
): Promise<string> {
  const p = provider();
  const token = new Contract(tokenAddress, ERC20_ABI, p);
  const balance = await token.balanceOf(userAddress);
  return formatUnits(balance, decimals);
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
): Promise<string> {
  const p = provider();
  const signer = await p.getSigner();
  const amountWei = parseUnits(amount, decimals);

  const token = new Contract(tokenAddress, ERC20_ABI, signer);
  onProgress?.('approve');
  const approveTx = await token.approve(bridgeContractAddress, amountWei);
  await approveTx.wait();

  const bridge = new Contract(bridgeContractAddress, BRIDGE_DEPOSIT_ABI, signer);
  onProgress?.('deposit');
  const depositTx = await bridge.deposit(tokenAddress, amountWei, mintlayerAddress);
  return depositTx.hash;
}
