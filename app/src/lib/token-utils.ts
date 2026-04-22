/**
 * Pure token utility helpers - safe to import in both server and browser code.
 */

/** Decode a `{ text, hex }` RPC field - text may be null even when data is present. */
export function hexToText(field: { text: string | null; hex: string } | null | undefined): string | null {
  if (!field) return null;
  if (field.text) return field.text;
  if (!field.hex) return null;
  try {
    const bytes = new Uint8Array((field.hex.match(/../g) ?? []).map((h: string) => parseInt(h, 16)));
    return new TextDecoder().decode(bytes) || null;
  } catch {
    return null;
  }
}
