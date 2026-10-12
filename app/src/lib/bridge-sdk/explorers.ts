/**
 * Explorer base URLs for both bridge legs. Kept next to the SDK so
 * components share one definition (tracked card, history rows).
 */

/** Mintlayer explorer base for a network type ('mainnet' | otherwise testnet). */
export const mlExplorerBase = (networkType: string): string =>
  networkType === 'mainnet'
    ? 'https://explorer.mintlayer.org'
    : 'https://lovelace.explorer.mintlayer.org';

/** Etherscan base for a bridge flavor ('' = mainnet, 'sepolia' = testnet). */
export const ethExplorerBase = (flavor: string): string =>
  flavor === '' ? 'https://etherscan.io' : 'https://sepolia.etherscan.io';
