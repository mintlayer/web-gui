/**
 * Bech32/bech32m address typo correction (BIP-173/BIP-350).
 *
 * The bech32 checksum is a 30-bit BCH code that can LOCATE up to two symbol
 * errors. When a pasted/typed address fails its checksum, this module tries
 * to find a correction within that distance and returns it for explicit
 * user confirmation - it never mutates the input silently.
 *
 * Ported from the BIP-173 reference (sipa/bech32) and validated against
 * live Mintlayer (tmt, bech32m) and Bitcoin (bcrt, bech32 + bech32m)
 * addresses.
 */

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const CONSTS = { bech32: 1, bech32m: 0x2bc830a3 } as const;

export type Chain = "btc" | "ml";

export interface CorrectionResult {
  /** 'valid' - input passes its checksum as typed */
  /** 'corrected' - checksum failed, but a fix within 2 character errors was found */
  /** 'invalid' - uncorrectable (charset violation, wrong length change, 3+ errors, wrong hrp) */
  status: "valid" | "corrected" | "invalid";
  /** The corrected address - present only when status === 'corrected'. Require explicit user confirmation before use. */
  corrected?: string;
  /** How many characters were fixed (1 or 2) */
  fixedChars?: number;
  reason?: string;
}

function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  const ret: number[] = [];
  for (const c of hrp) ret.push(c.charCodeAt(0) >> 5);
  ret.push(0);
  for (const c of hrp) ret.push(c.charCodeAt(0) & 31);
  return ret;
}

function reencode(hrp: string, payload: number[], encoding: "bech32" | "bech32m"): string {
  const values = hrpExpand(hrp).concat(payload);
  const chk = polymod(values.concat([0, 0, 0, 0, 0, 0])) ^ CONSTS[encoding];
  const cs: number[] = [];
  for (let i = 0; i < 6; i++) cs.push((chk >> (5 * (5 - i))) & 31);
  return hrp + "1" + payload.concat(cs).map((d) => CHARSET[d]).join("");
}

function isValidChainPayload(hrp: string, data: number[], encoding: "bech32" | "bech32m", chain: Chain): boolean {
  // `data` includes the 6-symbol checksum: [version, ...program, checksum]
  const version = data[0];
  if (version === undefined || version > 16) return false;
  if (chain === "btc") {
    const programLen = data.length - 7;
    if (version === 0) {
      if (encoding !== "bech32") return false;
      if (programLen !== 20 && programLen !== 32) return false;
    } else {
      if (encoding !== "bech32m") return false;
      // program length in symbols: 2..40 bytes -> ceil(bytes*8/5) symbols
      if (programLen < Math.ceil((2 * 8) / 5) || programLen > Math.ceil((40 * 8) / 5)) return false;
      // BIP-173: the final converted group's padding bits must be zero
      const bits = programLen * 5;
      const padBits = bits - Math.floor(bits / 8) * 8;
      if (padBits > 0 && (data[programLen] & ((1 << padBits) - 1)) !== 0) return false;
    }
  }
  // ML: final payload validation is the wallet daemon's job on submit.
  return true;
}

/** Per-network HRPs. */
export function hrpForNetwork(chain: Chain, network: string): string | null {
  if (chain === "btc") {
    switch (network) {
      case "mainnet": return "bc";
      case "testnet": return "tb";
      case "regtest": return "bcrt";
      case "signet": return "sb";
      default: return null;
    }
  }
  switch (network) {
    case "mainnet": return "mtc";
    case "testnet": return "tmt";
    default: return null; // ML regtest/signet hrps unverified - daemon validates
  }
}

/**
 * Check an address for checksum errors and attempt up to 2-character recovery.
 * `expectedHrp` scopes the address to one network (strongly recommended).
 * For BTC, segwit version/program rules are enforced on corrected candidates.
 */
export function suggestAddressCorrection(
  address: string,
  expectedHrp: string,
  chain: Chain,
): CorrectionResult {
  if (address !== address.toLowerCase() && address !== address.toUpperCase()) {
    return { status: "invalid", reason: "mixed case" };
  }
  const lower = address.toLowerCase();
  if (!/^[\x21-\x7e]+$/.test(lower)) {
    return { status: "invalid", reason: "invalid characters" };
  }

  // separator = last '1' such that the prefix equals the expected hrp
  let sep = -1;
  let idx = lower.indexOf(expectedHrp + "1");
  while (idx !== -1) {
    sep = idx + expectedHrp.length;
    idx = lower.indexOf(expectedHrp + "1", idx + 1);
  }
  if (sep < 1 || sep + 7 > lower.length) {
    return { status: "invalid", reason: "bad separator or hrp" };
  }
  const hrp = lower.slice(0, sep);
  const data = [...lower.slice(sep + 1)].map((c) => CHARSET.indexOf(c));
  if (data.some((d) => d < 0)) {
    return { status: "invalid", reason: "invalid character" };
  }

  const hrpExp = hrpExpand(hrp);
  const values = hrpExp.concat(data);
  const n = values.length;
  const dataStart = hrpExp.length;

  for (const encoding of ["bech32", "bech32m"] as const) {
    const target = CONSTS[encoding];
    const chk = polymod(values) ^ target;

    if (chk === 0 && isValidChainPayload(hrp, data, encoding, chain)) {
      return { status: "valid" };
    }

    // polymod is affine over GF(2) (initial chk=1): the linear response of a
    // single-symbol delta is polymod(delta) ^ polymod(zeros). Without
    // removing that constant, error syndromes never match.
    const c0 = polymod(new Array(n).fill(0));

    // single-error syndromes for all data positions x magnitudes
    const single = new Map<number, [number, number]>();
    for (let pos = dataStart; pos < n; pos++) {
      for (let m = 1; m < 32; m++) {
        const delta = new Array(n).fill(0);
        delta[pos] = m;
        const d = polymod(delta) ^ c0;
        if (!single.has(d)) single.set(d, [pos, m]);
      }
    }

    // 1-error correction
    for (const [d, [pos, m]] of single) {
      if ((chk ^ d) === 0) {
        const fixed = data.slice();
        fixed[pos - dataStart] ^= m;
        if (isValidChainPayload(hrp, fixed, encoding, chain)) {
          const corrected = reencode(hrp, fixed.slice(0, -6), encoding);
          if (corrected !== lower) {
            return { status: "corrected", corrected, fixedChars: 1 };
          }
        }
      }
    }

    // 2-error correction: fix one candidate, look up the remainder
    for (const [d1, [p1, m1]] of single) {
      const rest = chk ^ d1;
      if (rest === 0) continue;
      const hit = single.get(rest);
      if (hit && hit[0] !== p1) {
        const fixed = data.slice();
        fixed[p1 - dataStart] ^= m1;
        fixed[hit[0] - dataStart] ^= hit[1];
        if (isValidChainPayload(hrp, fixed, encoding, chain)) {
          const corrected = reencode(hrp, fixed.slice(0, -6), encoding);
          if (corrected !== lower) {
            return { status: "corrected", corrected, fixedChars: 2 };
          }
        }
      }
    }
  }

  return { status: "invalid", reason: "checksum mismatch (cannot auto-correct)" };
}
