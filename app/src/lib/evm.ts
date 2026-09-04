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

export function hasEthereumProvider(): boolean {
  return typeof window !== 'undefined' && !!window.ethereum;
}

function provider(): BrowserProvider {
  if (!hasEthereumProvider()) {
    throw new EvmError('MetaMask not installed');
  }
  return new BrowserProvider(window.ethereum as never);
}

/** Prompt MetaMask for account access. Returns the selected address. */
export async function connectMetaMask(): Promise<string> {
  if (!hasEthereumProvider()) {
    throw new EvmError(
      'MetaMask not installed. Install the MetaMask extension to bridge.',
    );
  }
  const accounts = (await window.ethereum!.request({
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
  if (!hasEthereumProvider()) throw new EvmError('MetaMask not installed');
  try {
    await window.ethereum!.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: chainIdHex }],
    });
  } catch (err) {
    const code = (err as { code?: number }).code;
    // 4902 = chain not added to the wallet
    if (code === 4902 && chainParams) {
      await window.ethereum!.request({
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
  return depositTx.hash as string;
}
