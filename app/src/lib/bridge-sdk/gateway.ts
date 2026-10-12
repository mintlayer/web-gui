const IPFS_PROXY = '/ipfs/';

/** Converts ipfs:// URIs to the same-origin gateway proxy; passes http(s) through. */
export const toGatewayUrl = (uri: string): string => {
  if (uri.startsWith('ipfs://ipfs/'))
    return IPFS_PROXY + uri.slice('ipfs://ipfs/'.length);
  if (uri.startsWith('ipfs://'))
    return IPFS_PROXY + uri.slice('ipfs://'.length);
  return uri;
};
