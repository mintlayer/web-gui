import { getBridgeApiUrl, getMintlayerApiUrl } from './config';
import { apiRequest } from './http';
import type { FetchLike } from './http';
import type {
  AddressInfo,
  BridgeConfig,
  BridgeFees,
  BridgeRequestDetail,
  BridgeRequestInput,
  BridgeRequestListItem,
  BridgeRequestResponse,
  DepositTransactionDetail,
  ListBridgeRequestsParams,
  TokenInfo,
} from './types';

export interface BridgeSdk {
  /** Bridge fee settings per asset and direction. */
  getFees: () => Promise<BridgeFees>;
  /** Broadcasts a signed bridge request. */
  broadcastBridgeRequest: (
    input: BridgeRequestInput,
  ) => Promise<BridgeRequestResponse>;
  /** Fetches a single bridge request by UUID. */
  getBridgeRequest: (id: string) => Promise<BridgeRequestDetail>;
  /** Network-wide bridge request feed (Live Activity). */
  listBridgeRequests: (
    params?: ListBridgeRequestsParams,
  ) => Promise<BridgeRequestListItem[]>;
  /** Fetches a deposit transaction by UUID. */
  getDepositTransaction: (id: string) => Promise<DepositTransactionDetail>;
  /** Fetches the bridge agents config (tokens, contracts, network type). */
  getConfig: () => Promise<BridgeConfig>;
  /** Mintlayer api-server: address lookup. */
  getMintlayerAddress: (address: string) => Promise<AddressInfo>;
  /** Mintlayer api-server: token lookup. */
  getTokenInfo: (tokenId: string) => Promise<TokenInfo>;
}

export interface BridgeSdkDeps {
  bridgeApiUrl?: string;
  mintlayerApiUrl?: string;
  fetchImpl?: FetchLike;
}

/**
 * Creates a bridge API client. All dependencies are injectable so callers
 * (and tests) can point it at any environment.
 */
export const createBridgeSdk = (
  deps: BridgeSdkDeps = {},
): BridgeSdk => {
  const bridgeUrl = deps.bridgeApiUrl ?? getBridgeApiUrl();
  const mlUrl = deps.mintlayerApiUrl ?? getMintlayerApiUrl();
  // Resolved lazily so environments without a global fetch (tests, SSR edge
  // cases) can still import the module and inject their own implementation.
  const fetchImpl: FetchLike =
    deps.fetchImpl ?? ((input, init) => fetch(input, init));

  return {
    getFees: () => apiRequest(`${bridgeUrl}fees`, {}, fetchImpl),

    listBridgeRequests: (params = {}) => {
      const query = new URLSearchParams();
      if (params.limit != null) query.set('limit', String(params.limit));
      if (params.status?.length) query.set('status', params.status.join(','));
      if (params.createdAfter) query.set('created_after', params.createdAfter);
      const qs = query.toString();
      return apiRequest(`${bridgeUrl}bridge-requests${qs ? `?${qs}` : ''}`, {}, fetchImpl);
    },

    broadcastBridgeRequest: (input) =>
      apiRequest(`${bridgeUrl}bridge-request`, { method: 'POST', body: input }, fetchImpl),

    getBridgeRequest: (id) =>
      apiRequest(`${bridgeUrl}bridge-request/${encodeURIComponent(id)}`, {}, fetchImpl),

    getDepositTransaction: (id) =>
      apiRequest(`${bridgeUrl}deposit-transaction/${encodeURIComponent(id)}`, {}, fetchImpl),

    getConfig: () => apiRequest(`${bridgeUrl}agents-config`, {}, fetchImpl),

    getMintlayerAddress: (address) =>
      apiRequest(`${mlUrl}address/${encodeURIComponent(address)}`, {}, fetchImpl),

    getTokenInfo: (tokenId) =>
      apiRequest(`${mlUrl}token/${encodeURIComponent(tokenId)}`, {}, fetchImpl),
  };
};

/** Default client using env-configured URLs and global fetch. */
export const bridgeSdk = createBridgeSdk();
