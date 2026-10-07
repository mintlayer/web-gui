/**
 * Canonical bech32/bech32m codec (BIP-173/BIP-350) for the whole app.
 *
 * Every implementation (address typo correction, token-id derivation,
 * bridge-sdk address validation) must import from here so the constants and
 * charset can never drift apart. The bech32m constant is 0x2bc830a3 per
 * BIP-350; validate any change against the live fixtures in bech32.test.ts.
 * See https://github.com/bitcoin/bips/blob/master/bip-0350.mediawiki
 */

export const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

/** bech32m constant (BIP-350) distinguishing from legacy bech32 (1). */
export const BECH32M_CONST = 0x2bc830a3;
export const BECH32_CONST = 1;

export type Bech32Encoding = 'bech32' | 'bech32m';

const ENCODING_CONSTS: Record<Bech32Encoding, number> = {
  bech32: BECH32_CONST,
  bech32m: BECH32M_CONST,
};

export function polymod(values: number[]): number {
  let chk = 1;
  for (const value of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i++) {
      if ((top >> i) & 1) chk ^= GENERATOR[i];
    }
  }
  return chk;
}

export function hrpExpand(hrp: string): number[] {
  const result: number[] = [];
  for (const c of hrp) result.push(c.charCodeAt(0) >> 5);
  result.push(0);
  for (const c of hrp) result.push(c.charCodeAt(0) & 31);
  return result;
}

export interface Bech32Decoded {
  prefix: string;
  /** 5-bit payload words, checksum excluded. */
  words: number[];
}

/**
 * Decodes and checksum-verifies a bech32 or bech32m string. Throws on mixed
 * case, invalid characters, bad separator position or checksum mismatch.
 */
export function decode(address: string, encoding: Bech32Encoding = 'bech32m'): Bech32Decoded {
  if (address.length < 8) throw new Error('bech32: too short');
  if (address.length > 1023) throw new Error('bech32: too long');

  const hasLower = /[a-z]/.test(address);
  const hasUpper = /[A-Z]/.test(address);
  if (hasLower && hasUpper) throw new Error('bech32: mixed case');

  const value = address.toLowerCase();
  // BIP-173: every character must be US-ASCII [33-126]. The data-part charset
  // check below is not enough on its own: hrp characters are never validated
  // against the charset, and a crafted non-ASCII hrp can still checksum.
  if (!/^[\x21-\x7e]+$/.test(value)) throw new Error('bech32: invalid character');

  const separatorIndex = value.lastIndexOf('1');
  if (separatorIndex < 1 || separatorIndex + 7 > value.length) {
    throw new Error('bech32: invalid separator position');
  }

  const prefix = value.slice(0, separatorIndex);
  const dataPart = value.slice(separatorIndex + 1);

  const words: number[] = [];
  for (const c of dataPart) {
    const index = CHARSET.indexOf(c);
    if (index === -1) throw new Error(`bech32: invalid character '${c}'`);
    words.push(index);
  }

  const checksum = polymod([...hrpExpand(prefix), ...words]);
  if (checksum !== ENCODING_CONSTS[encoding]) {
    throw new Error('bech32: checksum mismatch');
  }

  return { prefix, words: words.slice(0, -6) };
}

/** Encodes 5-bit payload words (checksum appended here). */
export function encodeWords(prefix: string, words: number[], encoding: Bech32Encoding = 'bech32m'): string {
  const values = [...hrpExpand(prefix), ...words, 0, 0, 0, 0, 0, 0];
  const mod = polymod(values) ^ ENCODING_CONSTS[encoding];
  const checksum: number[] = [];
  for (let i = 0; i < 6; i++) checksum.push((mod >> (5 * (5 - i))) & 31);
  return `${prefix}1${[...words, ...checksum].map((w) => CHARSET[w]).join('')}`;
}

/** General bit regrouping with optional padding (BIP-173 ref). */
export function convertbits(data: number[], frombits: number, tobits: number, pad: boolean): number[] {
  let acc = 0;
  let bits = 0;
  const result: number[] = [];
  const maxv = (1 << tobits) - 1;
  for (const value of data) {
    acc = ((acc << frombits) | value) & 0xfffff;
    bits += frombits;
    while (bits >= tobits) {
      bits -= tobits;
      result.push((acc >> bits) & maxv);
    }
  }
  if (pad && bits > 0) result.push((acc << (tobits - bits)) & maxv);
  return result;
}

/** Converts 8-bit bytes into 5-bit bech32 words (padded). */
export function toWords(bytes: Uint8Array): number[] {
  return convertbits(Array.from(bytes), 8, 5, true);
}

export type Bech32Chain = 'btc' | 'ml';

/** Per-network HRPs (ML testnet hrp is `tmt`). */
export function hrpForNetwork(chain: Bech32Chain, network: string): string | null {
  if (chain === 'btc') {
    switch (network) {
      case 'mainnet': return 'bc';
      case 'testnet': return 'tb';
      case 'regtest': return 'bcrt';
      case 'signet': return 'sb';
      default: return null;
    }
  }
  switch (network) {
    case 'mainnet': return 'mtc';
    case 'testnet': return 'tmt';
    default: return null; // ML regtest/signet hrps unverified - daemon validates
  }
}
