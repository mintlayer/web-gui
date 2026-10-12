import { describe, expect, it } from 'vitest';
import { decode, encodeWords, BECH32M_CONST } from '@/lib/bech32';
import { bech32mDecode, bech32mEncode } from '@/lib/bridge-sdk';
import { suggestAddressCorrection } from '@/lib/bech32-correct';
import { ethers } from 'ethers';

// Live Mintlayer testnet address (bech32m, hrp `tmt`) and BTC regtest address —
// the same cross-implementation fixtures used by bech32-correct.test.ts. If any
// codec in the app changes its constants, this test fails.
const ML_TESTNET_ADDRESS = 'tmt1q9rlgx4dsse920z35xh5d8s5ydlj3xl7gqeze89c';
const BTC_V0_REGTEST = 'bcrt1q2kyaddhscv9vpjgnmx7ldsd3uj3u7crg0j2nxj';

describe('bech32 shared codec', () => {
  it('uses the BIP-350 bech32m constant', () => {
    expect(BECH32M_CONST).toBe(0x2bc830a3);
  });

  it('decodes the live ML testnet address with the shared decoder', () => {
    const decoded = decode(ML_TESTNET_ADDRESS, 'bech32m');
    expect(decoded.prefix).toBe('tmt');
    expect(decoded.words.length).toBeGreaterThanOrEqual(16);
  });

  it('bridge-sdk decode/encode agree with the shared codec on the live fixture', () => {
    const shared = decode(ML_TESTNET_ADDRESS, 'bech32m');
    const sdk = bech32mDecode(ML_TESTNET_ADDRESS);
    expect(sdk.prefix).toBe(shared.prefix);
    expect(sdk.words).toEqual(shared.words);

    const reencoded = encodeWords(shared.prefix, shared.words, 'bech32m');
    expect(reencoded).toBe(ML_TESTNET_ADDRESS);
    expect(bech32mEncode(shared.prefix, shared.words)).toBe(ML_TESTNET_ADDRESS);
  });

  it('round-trips a regtest address (bech32, not bech32m)', () => {
    const decoded = decode(BTC_V0_REGTEST, 'bech32');
    expect(decoded.prefix).toBe('bcrt');
    expect(encodeWords(decoded.prefix, decoded.words, 'bech32')).toBe(BTC_V0_REGTEST);
    expect(() => decode(BTC_V0_REGTEST, 'bech32m')).toThrow(/checksum/);
  });

  it('re-encoding the decoded payload reproduces the address byte-for-byte (typo detector agreement)', () => {
    expect(suggestAddressCorrection(ML_TESTNET_ADDRESS, 'tmt', 'ml')).toEqual({ status: 'valid' });
    expect(suggestAddressCorrection(BTC_V0_REGTEST, 'bcrt', 'btc')).toEqual({ status: 'valid' });
  });

  it('rejects or corrects a tampered address consistently across codecs', () => {
    const tampered = ML_TESTNET_ADDRESS.slice(0, -1) + (ML_TESTNET_ADDRESS.endsWith('c') ? 'd' : 'c');
    expect(() => decode(tampered, 'bech32m')).toThrow(/checksum/);
    expect(() => bech32mDecode(tampered)).toThrow(/checksum/);
    // The typo corrector may recover a 1-char error — but only back to the
    // original address, never to something new.
    const result = suggestAddressCorrection(tampered, 'tmt', 'ml');
    expect(result.status === 'invalid' || result.corrected === ML_TESTNET_ADDRESS).toBe(true);
  });
});

describe('bridge-sdk address validators', () => {
  it('accepts EVM addresses per ethers (EIP-55 aware)', async () => {
    const { validateEvmAddress } = await import('@/lib/bridge-sdk');
    const checksummed = ethers.getAddress('0x' + 'ab'.repeat(20));
    expect(validateEvmAddress(checksummed).valid).toBe(true);
    expect(validateEvmAddress('0x123').valid).toBe(false);
  });
});
