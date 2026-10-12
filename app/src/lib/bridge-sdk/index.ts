/**
 * bridge-sdk public API.
 *
 * @example
 * import { createBridgeSdk } from '@/bridge-sdk';
 * const sdk = createBridgeSdk();
 * const config = await sdk.getConfig();
 */
export { createBridgeSdk } from './endpoints';
export type { BridgeSdk, BridgeSdkDeps } from './endpoints';
export type {
  BridgeRequestStatus,
  ListBridgeRequestsParams,
  BridgeRequestListItem,
} from './types';
export {
  DEFAULT_BRIDGE_API_URL,
  DEFAULT_MINTLAYER_API_URL,
  getBridgeApiUrl,
  getMintlayerApiUrl,
} from './config';
export { apiRequest, BridgeSdkError } from './http';
export type { RequestOptions, FetchLike, HttpMethod } from './http';
export type {
  BridgeConfig,
  BridgeFees,
  BridgeRequestInput,
  BridgeRequestResponse,
  BridgeRequestDetail,
  DepositTransaction,
  DepositTransactionDetail,
  AddressInfo,
  TokenInfo,
  EthFlavorConfig,
  DirectionalFees,
  AssetFees,
  FeeDirection,
} from './types';
export {
  validateDestinationAddress,
  validateEvmAddress,
  validateMintlayerAddress,
  ML_MAINNET_HRP,
  ML_TESTNET_HRP,
} from './addresses';
export type { AddressValidation, BridgeChain } from './addresses';
export { bech32mDecode, bech32mEncode, toWords, BECH32M_CONST } from './bech32m';
export type { Bech32mDecoded } from './bech32m';
export { toGatewayUrl, resolveTokenIcon } from './icons';
export {
  resolveTokenMetadata,
  sanitizeTokenMetadata,
} from './tokenMetadata';
export type { TokenMetadata, TokenMetadataLinks } from './tokenMetadata';
export {
  fetchUsdPrices,
  tickerToPriceId,
  PRICE_ID_BY_TICKER,
} from './prices';
export type { UsdPrices } from './prices';
export {
  IN_FLIGHT_KEY,
  IN_FLIGHT_EVENT,
  DEPOSIT_CONFIRMATIONS,
  PROGRESS_POLL_MS,
  saveInFlight,
  loadInFlight,
  clearInFlight,
  getSubscribeUrl,
  deriveProgress,
  isTxHashLike,
  isEthTxHash,
} from './progress';
export type {
  InFlightBridge,
  BridgeProgress,
  BridgeProgressKind,
} from './progress';
