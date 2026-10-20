import { describe, it, expect } from 'vitest';
import { mulDecimal, divDecimal, trimTrailingZeros } from './decimal';

describe('mulDecimal', () => {
  it('multiplies exactly without float artifacts', () => {
    expect(mulDecimal('0.1', '0.3')).toBe('0.03');
    expect(mulDecimal('0.7', '0.1')).toBe('0.07');
    expect(mulDecimal('1.1', '1.1')).toBe('1.21');
  });

  it('keeps significant trailing zeros in integer products', () => {
    // The old (parseFloat).toString + /\.?0+$/ strip turned these into "1".
    expect(mulDecimal('1000000', '10')).toBe('10000000');
    expect(mulDecimal('12000000', '1')).toBe('12000000');
    expect(mulDecimal('9000000', '1')).toBe('9000000');
  });

  it('trims only insignificant fraction zeros', () => {
    expect(mulDecimal('1.50', '2')).toBe('3');
    expect(mulDecimal('0.100', '0.100')).toBe('0.01');
    expect(mulDecimal('10', '10')).toBe('100');
  });

  it('handles signs and zero', () => {
    expect(mulDecimal('-2', '3')).toBe('-6');
    expect(mulDecimal('-2', '-3')).toBe('6');
    expect(mulDecimal('0', '5')).toBe('0');
    expect(mulDecimal('0.000', '5')).toBe('0');
  });

  it('supports very large values exactly', () => {
    // 99999999999.99999999 * 99999999999, exact (BigInt math, no rounding).
    expect(mulDecimal('99999999999.99999999', '99999999999')).toBe(
      '9999999999899999999000.00000001',
    );
  });

  it('rejects non-plain-decimal input', () => {
    expect(mulDecimal('1e5', '2')).toBeNull();
    expect(mulDecimal('1,234.5', '2')).toBeNull();
    expect(mulDecimal('', '2')).toBeNull();
    expect(mulDecimal('abc', '2')).toBeNull();
    expect(mulDecimal('1.2.3', '2')).toBeNull();
  });
});

describe('divDecimal', () => {
  it('divides and rounds half-up at the requested scale', () => {
    expect(divDecimal('6172.5', '1234.5')).toBe('5');
    expect(divDecimal('1', '3', 8)).toBe('0.33333333');
    expect(divDecimal('2', '3', 8)).toBe('0.66666667');
    expect(divDecimal('1', '4')).toBe('0.25');
  });

  it('keeps large quotients intact', () => {
    expect(divDecimal('10000000', '10')).toBe('1000000');
  });

  it('rejects division by zero and malformed input', () => {
    expect(divDecimal('1', '0')).toBeNull();
    expect(divDecimal('1', '0.000')).toBeNull();
    expect(divDecimal('x', '2')).toBeNull();
    expect(divDecimal('1', '1e3')).toBeNull();
  });
});

describe('trimTrailingZeros', () => {
  it('only touches the fraction part', () => {
    expect(trimTrailingZeros('10000000')).toBe('10000000');
    expect(trimTrailingZeros('12.5000')).toBe('12.5');
    expect(trimTrailingZeros('12.000')).toBe('12');
    expect(trimTrailingZeros('0.00000000')).toBe('0');
    expect(trimTrailingZeros('-0.000')).toBe('0');
  });
});
