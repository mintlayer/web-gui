/**
 * Transaction decoder using the Mintlayer WASM bindings.
 *
 * Decodes a hex-encoded signed transaction into a structured JS object
 * with human-readable addresses (bech32) and parsed outputs.
 *
 * The WASM package is architecture-neutral - built once from
 * wasm-wrappers in mintlayer-core and committed to this repo.
 */

import { createRequire } from 'node:module';
import { join } from 'node:path';

// Load the WASM nodejs CJS module by absolute path so that neither Vite's
// SSR module runner nor npm package resolution can interfere.
// process.cwd() is the `app/` directory in both local dev and Docker (/app).
const _wasmAbsPath = join(process.cwd(), 'wasm-wrappers', 'wasm_wrappers.js');
// createRequire needs a *different* file as its "parent module" - using the
// WASM file itself would make _require('./wasm_wrappers.js') resolve to itself.
const _require = createRequire(import.meta.url);
const { decode_signed_transaction_to_js, Network } = _require(_wasmAbsPath) as {
  decode_signed_transaction_to_js: (tx: Uint8Array, network: number) => unknown;
  Network: { Mainnet: 0; Testnet: 1; Regtest: 2; Signet: 3 };
};

// ── Types mirroring the WASM decoded output ────────────────────────────────────

/** A decoded output from the WASM library. Each output is a single-key object
 *  where the key is the variant name (Transfer, LockThenTransfer, Burn, …). */
export type DecodedOutput = Record<string, unknown>;

export interface DecodedInput {
  Utxo?: { id: { Transaction?: string; BlockReward?: string }; index: number };
  Account?: unknown;
  AccountCommand?: unknown;
  OrderAccountCommand?: unknown;
  [key: string]: unknown;
}

export interface DecodedTransaction {
  inputs: DecodedInput[];
  outputs: DecodedOutput[];
}

// ── Network detection ──────────────────────────────────────────────────────────

let loggedNetworkFallback = false;
function detectNetwork(): number {
  // Explicit env first - the repo-wide convention (NETWORK=mainnet|testnet|
  // regtest) also covers daemons configured via config file, which the old
  // CLI-substring probe silently mislabeled as mainnet.
  const env = (process.env.NETWORK ?? '').toLowerCase();
  if (env === 'mainnet') return Network.Mainnet;
  if (env === 'testnet') return Network.Testnet;
  if (env === 'regtest') return Network.Regtest;
  if (env === 'signet') return Network.Signet;

  const cmd = process.env.WALLET_RPC_CMD ?? '';
  if (cmd.includes('testnet')) return Network.Testnet;
  if (cmd.includes('regtest')) return Network.Regtest;
  if (cmd.includes('signet')) return Network.Signet;
  if (!loggedNetworkFallback) {
    loggedNetworkFallback = true;
    console.error('[tx-decoder] NETWORK is not set and WALLET_RPC_CMD declares no network - decoding as mainnet');
  }
  return Network.Mainnet;
}

// ── Decoder ───────────────────────────────────────────────────────────────────

/**
 * Decode a hex-encoded signed transaction (from `transaction_get_signed_raw`)
 * into a structured object. Returns null if the hex is null or decoding fails.
 */
export function decodeSignedTransaction(hex: string | null): DecodedTransaction | null {
  if (!hex) return null;

  try {
    const bytes = Uint8Array.from(Buffer.from(hex, 'hex'));
    const network = detectNetwork();
    const decoded = decode_signed_transaction_to_js(bytes, network) as {
      transaction?: { V1?: { inputs?: unknown[]; outputs?: unknown[] } };
    };

    const v1 = decoded?.transaction?.V1;
    if (!v1) return null;

    return {
      inputs: (v1.inputs ?? []) as DecodedInput[],
      outputs: (v1.outputs ?? []) as DecodedOutput[],
    };
  } catch {
    return null;
  }
}

// ── Output helpers ────────────────────────────────────────────────────────────

/** Extract the variant name (e.g. "Transfer", "LockThenTransfer") from a decoded output. */
export function outputVariant(output: DecodedOutput): string {
  return Object.keys(output)[0] ?? 'Unknown';
}

const TRANSFER_VARIANTS = new Set(['Transfer', 'LockThenTransfer']);

/** True if this output just moves coins/tokens (Transfer or LockThenTransfer). */
export function isTransferOutput(output: DecodedOutput): boolean {
  return TRANSFER_VARIANTS.has(outputVariant(output));
}

/** The TokenV1 id(s) an output moves, for batched decimals resolution. */
export function tokenIdsOfOutput(output: DecodedOutput): string[] {
  const variant = outputVariant(output);
  if (!TRANSFER_VARIANTS.has(variant)) return [];
  const args = output[variant] as unknown[];
  if (!Array.isArray(args) || args.length === 0) return [];
  const value = args[0] as { Coin?: unknown; TokenV1?: [string, unknown] };
  return value?.TokenV1 ? [value.TokenV1[0]] : [];
}

/**
 * Extract the value from a Transfer or LockThenTransfer output.
 * Returns a human-readable string like "1.5 ML" or "100.0 (token ttkn1…)".
 * Token amounts use the token's on-chain `number_of_decimals` when the
 * caller supplies one (batched via getTokensInfo); without it the raw
 * value is rendered with an explicit `atoms` hint - silently dividing by
 * a guessed precision would show a wrong amount.
 */
export function outputValueLabel(output: DecodedOutput, tokenDecimals?: Map<string, number>): string | null {
  const variant = outputVariant(output);
  if (!TRANSFER_VARIANTS.has(variant)) return null;

  // Both Transfer and LockThenTransfer have value as the first element of an array
  const args = output[variant] as unknown[];
  if (!Array.isArray(args) || args.length === 0) return null;

  const value = args[0] as { Coin?: { atoms: string }; TokenV1?: [string, { atoms: string }] };
  if (value?.Coin) return `${atomsToDecimal(value.Coin.atoms, 11)} ML`;
  if (value?.TokenV1) {
    const [tokenId, amount] = value.TokenV1;
    const decimals = tokenDecimals?.get(tokenId);
    const pretty =
      typeof decimals === 'number' && Number.isInteger(decimals) && decimals >= 0
        ? atomsToDecimal(amount.atoms, decimals)
        : `${amount.atoms} atoms`;
    return `${pretty} (token ${tokenId.slice(0, 12)}…)`;
  }
  return null;
}

function atomsToDecimal(atoms: string, decimals: number): string {
  if (decimals === 0) return atoms;
  const n = BigInt(atoms);
  const divisor = 10n ** BigInt(decimals);
  const whole = n / divisor;
  const frac = n % divisor;
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
  return fracStr ? `${whole}.${fracStr}` : `${whole}`;
}
