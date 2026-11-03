/**
 * Exact decimal-string arithmetic for order amounts.
 *
 * Order totals end up in `amount.decimal` fields that the daemon parses as
 * exact decimals, and the same numbers are what the user confirms on screen.
 * Float math corrupts both ends: 0.1 * 0.3 === 0.30000000000000004 (rejected
 * by the daemon), and naive trailing-zero strips eat significant digits
 * (10000000 -> "1"). These helpers compute on BigInt unscaled values so
 * every result is the mathematically exact decimal, then format minimally.
 */

interface Decimal {
  neg: boolean;
  unscaled: bigint; // digits without the decimal point
  scale: number;    // number of fraction digits
}

function parseDecimal(raw: string): Decimal | null {
  const s = raw.trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null; // rejects '', '1e5', 'NaN', ','
  const neg = s.startsWith('-');
  const body = neg ? s.slice(1) : s;
  const dot = body.indexOf('.');
  const unscaled = BigInt(dot === -1 ? body : body.replace('.', ''));
  return { neg: neg && unscaled !== 0n, unscaled, scale: dot === -1 ? 0 : body.length - dot - 1 };
}

function formatUnscaled(value: Decimal): string {
  if (value.unscaled === 0n) return '0';
  let digits = value.unscaled.toString();
  if (value.scale > 0) {
    if (digits.length <= value.scale) digits = digits.padStart(value.scale + 1, '0');
    digits = `${digits.slice(0, digits.length - value.scale)}.${digits.slice(digits.length - value.scale)}`;
  }
  return value.neg ? `-${digits}` : digits;
}

/** Strip fraction-only trailing zeros: '0.030000' -> '0.03'; integers untouched. */
export function trimTrailingZeros(s: string): string {
  if (!s.includes('.')) return s;
  const trimmed = s.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed === '' || trimmed === '-' || trimmed === '-0' ? '0' : trimmed;
}

/**
 * Exact product of two decimal strings, or null when either input is not a
 * plain decimal number. '0.1' * '0.3' === '0.03'; '1000000' * '10' stays
 * '10000000'.
 */
export function mulDecimal(a: string, b: string): string | null {
  const da = parseDecimal(a);
  const db = parseDecimal(b);
  if (!da || !db) return null;
  return trimTrailingZeros(
    formatUnscaled({
      neg: da.neg !== db.neg,
      unscaled: da.unscaled * db.unscaled,
      scale: da.scale + db.scale,
    }),
  );
}

/**
 * Quotient a/b rounded half-up to `maxScale` fraction digits (display
 * estimates), or null when either input is not a plain decimal or b is 0.
 */
export function divDecimal(a: string, b: string, maxScale = 8): string | null {
  const da = parseDecimal(a);
  const db = parseDecimal(b);
  if (!da || !db || db.unscaled === 0n || maxScale < 0) return null;
  const num = da.unscaled * 10n ** BigInt(db.scale + maxScale);
  const den = db.unscaled * 10n ** BigInt(da.scale);
  let q = num / den;
  if ((num % den) * 2n >= den) q += 1n;
  return trimTrailingZeros(formatUnscaled({ neg: da.neg !== db.neg, unscaled: q, scale: maxScale }));
}
