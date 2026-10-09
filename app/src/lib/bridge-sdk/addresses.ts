import { ethers } from 'ethers';
import { bech32mDecode } from './bech32m';

export type BridgeChain = 'ML' | 'ETH';

export interface AddressValidation {
  valid: boolean;
  /** User-facing message when invalid. */
  error?: string;
}

export const ML_MAINNET_HRP = 'mtc';
export const ML_TESTNET_HRP = 'tmtc';

const hrpForNetwork = (network?: 'mainnet' | 'testnet'): string | null => {
  if (network === 'mainnet') return ML_MAINNET_HRP;
  if (network === 'testnet') return ML_TESTNET_HRP;
  return null;
};

/**
 * Validates an EVM address (format + EIP-55 checksum when mixed case).
 */
export function validateEvmAddress(address: string): AddressValidation {
  if (ethers.isAddress(address.trim())) return { valid: true };
  return {
    valid: false,
    error: 'That doesn’t look like an Ethereum address (expected 0x followed by 40 hex characters).',
  };
}

/**
 * Validates a Mintlayer address: bech32m charset + checksum, the network
 * human-readable prefix, and a sane payload length. The bech32m checksum is
 * what lets a mistyped address be rejected instead of silently accepted.
 */
export function validateMintlayerAddress(
  address: string,
  network?: 'mainnet' | 'testnet',
): AddressValidation {
  const value = address.trim();
  const expectedHrp = hrpForNetwork(network);

  let decoded: { prefix: string; words: number[] };
  try {
    decoded = bech32mDecode(value);
  } catch {
    return {
      valid: false,
      error: 'Invalid Mintlayer address — the checksum doesn’t match, so the address likely contains a typo.',
    };
  }

  if (expectedHrp && decoded.prefix !== expectedHrp) {
    const networkName = expectedHrp === ML_MAINNET_HRP ? 'mainnet' : 'testnet';
    return {
      valid: false,
      error: `That's a Mintlayer ${decoded.prefix}… address, but this bridge runs on ${networkName} (expected ${expectedHrp}1…).`,
    };
  }

  if (decoded.words.length < 16) {
    return { valid: false, error: 'That Mintlayer address is too short to be valid.' };
  }

  return { valid: true, error: undefined };
}

/**
 * Validates the bridge destination address for the target chain.
 * `network` is the Mintlayer network of the bridge config (mainnet/testnet).
 */
export function validateDestinationAddress(
  address: string,
  chain: BridgeChain,
  network?: 'mainnet' | 'testnet',
): AddressValidation {
  const value = address.trim();
  if (!value) return { valid: false, error: 'Enter the destination address.' };

  return chain === 'ETH'
    ? validateEvmAddress(value)
    : validateMintlayerAddress(value, network);
}
