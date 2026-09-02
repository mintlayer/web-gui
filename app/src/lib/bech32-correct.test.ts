import { describe, it, expect } from "vitest";
import { suggestAddressCorrection, hrpForNetwork } from "@/lib/bech32-correct";

// Live addresses: ML testnet from the wallet daemon, BTC regtest from bitcoind.
const ML = "tmt1q9rlgx4dsse920z35xh5d8s5ydlj3xl7gqeze89c";
const BTC_V0 = "bcrt1q2kyaddhscv9vpjgnmx7ldsd3uj3u7crg0j2nxj";

// bech32m v1 (taproot-style) address, 32-byte program under bcrt
function toBech32mV1(hrp: string): string {
  const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  const polymod = (values: number[]) => {
    let chk = 1;
    for (const v of values) {
      const top = chk >> 25;
      chk = ((chk & 0x1ffffff) << 5) ^ v;
      for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i];
    }
    return chk;
  };
  const hrpExpand = (hrp: string) => {
    const r: number[] = [];
    for (const c of hrp) r.push(c.charCodeAt(0) >> 5);
    r.push(0);
    for (const c of hrp) r.push(c.charCodeAt(0) & 31);
    return r;
  };
  const program = Uint8Array.from(Buffer.from("751e76e8199196d454941c45d1b3a323f1433bd6751e76e8199196d454941c45", "hex"));
  const data5 = [1];
  let acc = 0, bits = 0;
  for (const b of program) {
    acc = (acc << 8) | b; bits += 8;
    while (bits >= 5) { data5.push((acc >> (bits - 5)) & 31); bits -= 5; }
  }
  if (bits) data5.push((acc << (5 - bits)) & 31);
  const values = hrpExpand(hrp).concat(data5);
  const chk = polymod(values.concat([0, 0, 0, 0, 0, 0])) ^ 0x2bc830a3;
  const cs: number[] = [];
  for (let i = 0; i < 6; i++) cs.push((chk >> (5 * (5 - i))) & 31);
  return hrp + "1" + data5.concat(cs).map((d) => CHARSET[d]).join("");
}
const BTC_V1 = toBech32mV1("bcrt");

describe("suggestAddressCorrection", () => {
  it("accepts valid addresses as-is", () => {
    expect(suggestAddressCorrection(ML, "tmt", "ml")).toEqual({ status: "valid" });
    expect(suggestAddressCorrection(BTC_V0, "bcrt", "btc")).toEqual({ status: "valid" });
    expect(suggestAddressCorrection(BTC_V1, "bcrt", "btc")).toEqual({ status: "valid" });
  });

  it("corrects 1 substitution on ML", () => {
    const typo = ML.slice(0, 30) + "f" + ML.slice(31);
    const r = suggestAddressCorrection(typo, "tmt", "ml");
    expect(r).toEqual({ status: "corrected", corrected: ML, fixedChars: 1 });
  });

  it("corrects 1 substitution on BTC", () => {
    const typo = BTC_V0.replace("kya", "kyd");
    const r = suggestAddressCorrection(typo, "bcrt", "btc");
    expect(r).toEqual({ status: "corrected", corrected: BTC_V0, fixedChars: 1 });
  });

  it("corrects 2 substitutions on ML and BTC", () => {
    const mlTypo = ML.slice(0, 10) + (ML[10] === "2" ? "3" : "2") + ML.slice(11, 30) + (ML[30] === "e" ? "f" : "e") + ML.slice(31);
    expect(suggestAddressCorrection(mlTypo, "tmt", "ml")).toEqual({
      status: "corrected", corrected: ML, fixedChars: 2,
    });
    const btcTypo = BTC_V0.slice(0, 8) + (BTC_V0[8] === "k" ? "m" : "k") + BTC_V0.slice(9, 25) + (BTC_V0[25] === "g" ? "h" : "g") + BTC_V0.slice(26);
    expect(suggestAddressCorrection(btcTypo, "bcrt", "btc")).toEqual({
      status: "corrected", corrected: BTC_V0, fixedChars: 2,
    });
  });

  it("corrects 1 substitution on a bech32m v1 address", () => {
    const typo = BTC_V1.slice(0, 10) + (BTC_V1[10] === "p" ? "q" : "p") + BTC_V1.slice(11);
    const r = suggestAddressCorrection(typo, "bcrt", "btc");
    expect(r).toEqual({ status: "corrected", corrected: BTC_V1, fixedChars: 1 });
  });

  it("cannot correct 3 substitutions", () => {
    const typo = ML.slice(0, 5) + "abc" + ML.slice(8);
    const r = suggestAddressCorrection(typo, "tmt", "ml");
    expect(r.status).toBe("invalid");
    expect(r.corrected).toBeUndefined();
  });

  it("cannot correct insertions or deletions", () => {
    expect(suggestAddressCorrection(ML.replace("dsse", "dse"), "tmt", "ml").status).toBe("invalid");
    expect(suggestAddressCorrection(ML.slice(0, 8) + "q" + ML.slice(8), "tmt", "ml").status).toBe("invalid");
  });

  it("rejects charset violations without hallucinating a fix", () => {
    // '1' inside the data part breaks separator detection
    const typo = BTC_V0.slice(0, 12) + "1" + BTC_V0.slice(13);
    expect(suggestAddressCorrection(typo, "bcrt", "btc").status).toBe("invalid");
  });

  it("rejects mixed case", () => {
    expect(suggestAddressCorrection(BTC_V0.slice(0, 5) + "Q" + BTC_V0.slice(6), "bcrt", "btc").status).toBe("invalid");
  });

  it("rejects wrong-network hrp", () => {
    expect(suggestAddressCorrection(BTC_V0, "tmt", "ml").status).toBe("invalid");
  });

  it("repairs a corrupted witness-version symbol on bech32m v1", () => {
    // first program symbol is the version marker (p=1); typo to q (0) and
    // expect the original v1 address to be recovered
    const typo = BTC_V1.slice(0, 5) + "q" + BTC_V1.slice(6);
    const r = suggestAddressCorrection(typo, "bcrt", "btc");
    expect(r).toEqual({ status: "corrected", corrected: BTC_V1, fixedChars: 1 });
  });

  it("rejects v0 addresses with invalid program length even when checksummed", () => {
    // build a bech32 (v0) address with a 37-symbol program (invalid: v0 must
    // be 20 or 32 bytes); its checksum is valid, so only the payload rule
    // rejects it
    const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
    const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    const polymod = (values: number[]) => {
      let chk = 1;
      for (const v of values) {
        const top = chk >> 25;
        chk = ((chk & 0x1ffffff) << 5) ^ v;
        for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i];
      }
      return chk;
    };
    const hrpExpand = (hrp: string) => {
      const r: number[] = [];
      for (const c of hrp) r.push(c.charCodeAt(0) >> 5);
      r.push(0);
      for (const c of hrp) r.push(c.charCodeAt(0) & 31);
      return r;
    };
    const payload = [0, ...new Array(37).fill(0)]; // v0 + 37-symbol program
    const values = hrpExpand("bcrt").concat(payload);
    const chk = polymod(values.concat([0, 0, 0, 0, 0, 0])) ^ 1;
    const cs: number[] = [];
    for (let i = 0; i < 6; i++) cs.push((chk >> (5 * (5 - i))) & 31);
    const addr = "bcrt" + "1" + payload.concat(cs).map((d) => CHARSET[d]).join("");
    expect(suggestAddressCorrection(addr, "bcrt", "btc").status).toBe("invalid");
  });
});

describe("hrpForNetwork", () => {
  it("maps BTC networks", () => {
    expect(hrpForNetwork("btc", "mainnet")).toBe("bc");
    expect(hrpForNetwork("btc", "testnet")).toBe("tb");
    expect(hrpForNetwork("btc", "regtest")).toBe("bcrt");
    expect(hrpForNetwork("btc", "signet")).toBe("sb");
  });

  it("maps ML networks", () => {
    expect(hrpForNetwork("ml", "mainnet")).toBe("mtc");
    expect(hrpForNetwork("ml", "testnet")).toBe("tmt");
  });

  it("returns null for unknown networks", () => {
    expect(hrpForNetwork("ml", "unknown")).toBeNull();
    expect(hrpForNetwork("btc", "unknown")).toBeNull();
  });
});
