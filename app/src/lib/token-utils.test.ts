import { describe, it, expect } from 'vitest';
import { hexToText } from '@/lib/token-utils';

describe('hexToText', () => {
  it('returns null for null input', () => {
    expect(hexToText(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(hexToText(undefined)).toBeNull();
  });

  it('returns field.text when text is a non-empty string', () => {
    expect(hexToText({ text: 'hello', hex: '68656c6c6f' })).toBe('hello');
  });

  it('returns null when text is null and hex is empty string', () => {
    expect(hexToText({ text: null, hex: '' })).toBeNull();
  });

  it('decodes hex to UTF-8 when text is null', () => {
    // "hello" in hex
    expect(hexToText({ text: null, hex: '68656c6c6f' })).toBe('hello');
  });

  it('handles non-ASCII UTF-8 characters correctly', () => {
    // "café" encoded as UTF-8 hex
    const encoder = new TextEncoder();
    const bytes = encoder.encode('café');
    const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    expect(hexToText({ text: null, hex })).toBe('café');
  });

  it('returns the decoded string even for a single null byte (not empty)', () => {
    // '00' decodes to the null character '\u0000', which is NOT an empty string
    // The function returns it as-is (the || null guard only catches empty string "")
    const result = hexToText({ text: null, hex: '00' });
    expect(result).toBe('\u0000');
  });

  it('returns null when hex decodes to empty string (no bytes produce empty output)', () => {
    // Empty hex → no bytes → empty Uint8Array → TextDecoder returns "" → null
    expect(hexToText({ text: null, hex: '' })).toBeNull();
  });

  it('returns null on exception from malformed hex (odd-length)', () => {
    // "abc" is odd-length hex - match(/../g) will skip last char so parseInt('') = NaN
    // The resulting Uint8Array with NaN gets set to 0, which decodes but is empty
    // Either way the function must not throw
    expect(() => hexToText({ text: null, hex: 'abc' })).not.toThrow();
  });

  it('prefers text over hex when both are present', () => {
    expect(hexToText({ text: 'from text', hex: '68656c6c6f' })).toBe('from text');
  });
});
