/**
 * bridge-sdk re-exports of the canonical bech32 codec (@/lib/bech32) so the
 * SDK's public surface stays stable. Kept as a thin wrapper - the constants
 * and algorithm live in ONE place app-wide to prevent drift.
 * See https://github.com/bitcoin/bips/blob/master/bip-0350.mediawiki
 */

export {
  BECH32M_CONST,
  decode as bech32mDecode,
  encodeWords as bech32mEncode,
  toWords,
} from '../bech32';

export type { Bech32Decoded as Bech32mDecoded } from '../bech32';
