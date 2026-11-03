/**
 * Explorer base URL for tx/pool/delegation/token links.
 *
 * Layout.astro renders the resolved base (ML_EXPLORER_URL override, else the
 * network's public explorer) into <body data-explorer-base>, so the override
 * that management/transactions.astro honors applies to client links too.
 * Networks without a public explorer (regtest/signet) resolve to '' - callers
 * must degrade to plain text instead of linking at a dead mainnet URL.
 */
export function explorerBase(): string {
  if (typeof document !== 'undefined') {
    const rendered = document.body?.dataset['explorerBase'];
    if (rendered !== undefined) return rendered;
  }
  // Fallback when the attribute is absent (tests, non-Layout hosts).
  const network = typeof document !== 'undefined'
    ? (document.body?.dataset['network'] ?? 'mainnet')
    : 'mainnet';
  if (network === 'testnet') return 'https://lovelace.explorer.mintlayer.org';
  if (network === 'mainnet') return 'https://explorer.mintlayer.org';
  return '';
}
