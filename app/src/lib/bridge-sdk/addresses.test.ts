import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';

import {
  validateMintlayerAddress,
  validateEvmAddress,
  validateDestinationAddress,
  bech32mEncode,
} from '@/lib/bridge-sdk';

// Live testnet fixture: only decodes with the correct BIP-350 bech32m
// constant 0x2bc830a3 - locks the checksum-constant regression fix.
const TESTNET_ADDRESS = 'tmt1q9rlgx4dsse920z35xh5d8s5ydlj3xl7gqeze89c';

describe('validateMintlayerAddress', () => {
  it('accepts a valid testnet address', () => {
    expect(validateMintlayerAddress(TESTNET_ADDRESS, 'testnet')).toEqual({ valid: true });
  });

  it('rejects a testnet address when the bridge runs on mainnet', () => {
    const res = validateMintlayerAddress(TESTNET_ADDRESS, 'mainnet');
    expect(res.valid).toBe(false);
    expect(res.error).toContain('mtc');
  });

  it('rejects a checksum-corrupted address as a likely typo', () => {
    const res = validateMintlayerAddress(
      'tmt1q9rlgx4dsse920z35xh5d8s5ydlj3xl7gqeze89d',
      'testnet',
    );
    expect(res.valid).toBe(false);
    expect(res.error).toContain('checksum');
    expect(res.error).toContain('typo');
  });

  it('rejects a bech32m-decodable address whose payload is too short', () => {
    // 8 payload words decode cleanly but no real address is that short.
    const shortAddress = bech32mEncode('tmt', [1, 2, 3, 4, 5, 6, 7, 8]);
    const res = validateMintlayerAddress(shortAddress, 'testnet');
    expect(res.valid).toBe(false);
    expect(res.error).toContain('too short');
  });
});

describe('validateEvmAddress', () => {
  it('accepts a checksummed address', () => {
    const checksummed = ethers.getAddress(`0x${'ab'.repeat(20)}`);
    expect(validateEvmAddress(checksummed)).toEqual({ valid: true });
  });

  it('rejects a truncated address with a user-facing message', () => {
    const res = validateEvmAddress('0x123');
    expect(res.valid).toBe(false);
    expect(res.error).toContain('Ethereum address');
  });
});

describe('validateDestinationAddress', () => {
  it('rejects an empty address', () => {
    const res = validateDestinationAddress('', 'ML', 'testnet');
    expect(res.valid).toBe(false);
    expect(res.error).toBe('Enter the destination address.');
  });

  it('routes ETH destinations to the EVM validator', () => {
    expect(validateDestinationAddress(`0x${'ab'.repeat(20)}`, 'ETH')).toEqual({ valid: true });
    const bad = validateDestinationAddress('0x123', 'ETH');
    expect(bad.valid).toBe(false);
    expect(bad.error).toContain('Ethereum address');
  });

  it('routes ML destinations to the Mintlayer validator', () => {
    expect(validateDestinationAddress(TESTNET_ADDRESS, 'ML', 'testnet')).toEqual({ valid: true });
    const wrongNetwork = validateDestinationAddress(TESTNET_ADDRESS, 'ML', 'mainnet');
    expect(wrongNetwork.valid).toBe(false);
    expect(wrongNetwork.error).toContain('mtc');
  });
});
