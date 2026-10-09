/**
 * Minimal bech32m codec (BIP-350) used for Mintlayer address checksum
 * validation. Self-contained so the SDK has no native/ESM edge cases.
 * See https://github.com/bitcoin/bips/blob/master/bip-0350.mediawiki
 */

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

/** bech32m constant (0x2bc832a3) distinguishes from legacy bech32 (1). */
export const BECH32M_CONST = 0x2bc832a3;

const polymod = (values: number[]): number => {
  let chk = 1;
  for (const value of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i++) {
      if ((top >> i) & 1) chk ^= GENERATOR[i];
    }
  }
  return chk;
};

const hrpExpand = (hrp: string): number[] => {
  const result: number[] = [];
  for (const c of hrp) result.push(c.charCodeAt(0) >> 5);
  result.push(0);
  for (const c of hrp) result.push(c.charCodeAt(0) & 31);
  return result;
};

const verifyChecksum = (hrp: string, data: number[]): boolean =>
  polymod([...hrpExpand(hrp), ...data]) === BECH32M_CONST;

export interface Bech32mDecoded {
  prefix: string;
  /** 5-bit payload words, checksum excluded. */
  words: number[];
}

/**
 * Decodes and checksum-verifies a bech32m string. Throws on mixed case,
 * invalid characters, bad separator or checksum mismatch.
 */
export function bech32mDecode(address: string): Bech32mDecoded {
  if (address.length < 8) throw new Error('bech32m: too short');
  if (address.length > 1023) throw new Error('bech32m: too long');

  const hasLower = /[a-z]/.test(address);
  const hasUpper = /[A-Z]/.test(address);
  if (hasLower && hasUpper) throw new Error('bech32m: mixed case');

  const value = address.toLowerCase();
  const separatorIndex = value.lastIndexOf('1');
  if (separatorIndex < 1 || separatorIndex + 7 > value.length) {
    throw new Error('bech32m: invalid separator position');
  }

  const prefix = value.slice(0, separatorIndex);
  const dataPart = value.slice(separatorIndex + 1);

  const words: number[] = [];
  for (const c of dataPart) {
    const index = CHARSET.indexOf(c);
    if (index === -1) throw new Error(`bech32m: invalid character '${c}'`);
    words.push(index);
  }

  if (!verifyChecksum(prefix, words)) {
    throw new Error('bech32m: checksum mismatch');
  }

  return { prefix, words: words.slice(0, -6) };
}

/** Encodes a payload into a bech32m string (used by tests/fixtures). */
export function bech32mEncode(prefix: string, words: number[]): string {
  const checksumInput = [...hrpExpand(prefix), ...words, 0, 0, 0, 0, 0, 0];
  const mod = polymod(checksumInput) ^ BECH32M_CONST;
  const checksum: number[] = [];
  for (let i = 0; i < 6; i++) checksum.push((mod >> (5 * (5 - i))) & 31);
  const data = [...words, ...checksum];
  return `${prefix}1${data.map((w) => CHARSET[w]).join('')}`;
}

/** Converts 8-bit bytes into 5-bit bech32 words. */
export function toWords(bytes: Uint8Array): number[] {
  const words: number[] = [];
  let accumulator = 0;
  let bits = 0;
  const mask = (1 << 5) - 1;
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | (byte & 0xff);
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      words.push((accumulator >> bits) & mask);
    }
  }
  if (bits > 0) words.push((accumulator << (5 - bits)) & mask);
  return words;
}
