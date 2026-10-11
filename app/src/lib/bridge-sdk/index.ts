/**
 * bridge-sdk public API.
 *
 * @example
 * import { bridgeSdk } from '@/bridge-sdk';
 * const config = await bridgeSdk.getConfig();
 */
export { createBridgeSdk, bridgeSdk } from './endpoints';
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
export { apiRequest, apiRequestText, BridgeSdkError } from './http';
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
export { resolveTokenIcon, toGatewayUrl } from './icons';
