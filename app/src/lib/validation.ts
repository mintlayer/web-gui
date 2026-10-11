/**
 * Shared input validators for money paths. One implementation, used by
 * client components and API routes alike, so the rules can never drift
 * between what the UI accepts and what the server enforces.
 */

/** Positive decimal string ("12.5"), no sign, no exponent, no leading '+'. */
export function isPositiveDecimal(value: string): boolean {
  return /^\d+(\.\d+)?$/.test(value.trim()) && parseFloat(value.trim()) > 0;
}

/**
 * Positive decimal string with a bounded number of fractional digits
 * (e.g. maxDecimals: 8 for BTC). Rejects "", "1.", ".5", "1.2.3", "-1", "1e3".
 */
export function isValidAmount(value: string, maxDecimals: number): boolean {
  const t = value.trim();
  return new RegExp(`^\\d{1,38}(\\.\\d{1,${maxDecimals}})?$`).test(t) && parseFloat(t) > 0;
}

/** EVM address: 0x + 40 hex chars (checksum handled by ethers at the edges). */
export function isEvmAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value.trim());
}
