import { describe, it, expect } from 'vitest';

import { isPositiveDecimal, isValidAmount, isEvmAddress } from '@/lib/validation';

describe('isPositiveDecimal', () => {
  it('accepts positive decimal strings', () => {
    expect(isPositiveDecimal('1')).toBe(true);
    expect(isPositiveDecimal('0.5')).toBe(true);
    expect(isPositiveDecimal('0001.500')).toBe(true);
  });

  it('accepts surrounding whitespace (trimmed)', () => {
    expect(isPositiveDecimal(' 12.34 ')).toBe(true);
  });

  it('rejects zero in any spelling', () => {
    expect(isPositiveDecimal('0')).toBe(false);
    expect(isPositiveDecimal('0.00')).toBe(false);
  });

  it('rejects signs, exponents and malformed decimals', () => {
    expect(isPositiveDecimal('-1')).toBe(false);
    expect(isPositiveDecimal('')).toBe(false);
    expect(isPositiveDecimal('1e3')).toBe(false);
    expect(isPositiveDecimal('1.2.3')).toBe(false);
    expect(isPositiveDecimal('1.')).toBe(false);
    expect(isPositiveDecimal('.5')).toBe(false);
  });

  it('rejects non-numeric input', () => {
    expect(isPositiveDecimal('abc')).toBe(false);
  });
});

describe('isValidAmount', () => {
  it('accepts decimals within the max decimal places', () => {
    expect(isValidAmount('0.12345678', 8)).toBe(true);
    expect(isValidAmount('1.23', 2)).toBe(true);
  });

  it('rejects more fractional digits than allowed', () => {
    expect(isValidAmount('0.123456789', 8)).toBe(false);
    expect(isValidAmount('1.234', 2)).toBe(false);
  });

  it('rejects malformed decimal shapes', () => {
    for (const bad of ['', '.', '1.', '.5', '1..2', '1.2.3']) {
      expect(isValidAmount(bad, 8)).toBe(false);
    }
  });

  it('rejects signs, exponents and non-numeric input', () => {
    for (const bad of ['-1', '1e3', 'abc']) {
      expect(isValidAmount(bad, 8)).toBe(false);
    }
  });

  it('rejects zero', () => {
    expect(isValidAmount('0', 8)).toBe(false);
  });
});

describe('isEvmAddress', () => {
  it('accepts 0x + 40 hex characters in any case', () => {
    expect(isEvmAddress(`0x${'ab'.repeat(20)}`)).toBe(true);
    expect(isEvmAddress(`0x${'AB'.repeat(20)}`)).toBe(true);
    expect(isEvmAddress('0x1111111111111111111111111111111111111111')).toBe(true);
  });

  it('accepts surrounding whitespace (trimmed)', () => {
    expect(isEvmAddress(` 0x${'ab'.repeat(20)} `)).toBe(true);
  });

  it('rejects wrong-length payloads', () => {
    expect(isEvmAddress('0x123')).toBe(false);
    expect(isEvmAddress(`0x${'a'.repeat(39)}`)).toBe(false);
    expect(isEvmAddress(`0x${'a'.repeat(41)}`)).toBe(false);
  });

  it('rejects an uppercase 0X prefix and non-EVM strings', () => {
    expect(isEvmAddress(`0X${'ab'.repeat(20)}`)).toBe(false);
    expect(isEvmAddress('tmt1q9rlgx4dsse920z35xh5d8s5ydlj3xl7gqeze89c')).toBe(false);
    expect(isEvmAddress('')).toBe(false);
  });
});
