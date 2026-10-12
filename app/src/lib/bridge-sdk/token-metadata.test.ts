import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  sanitizeTokenMetadata,
  resolveTokenMetadata,
} from './tokenMetadata';
import { toGatewayUrl } from './gateway';
import { resolveTokenIcon } from './icons';

describe('toGatewayUrl', () => {
  it('converts ipfs:// URIs to the same-origin proxy path', () => {
    expect(toGatewayUrl('ipfs://QmHash')).toBe('/ipfs/QmHash');
    expect(toGatewayUrl('ipfs://ipfs/QmHash')).toBe('/ipfs/QmHash');
  });

  it('passes http(s) and relative URLs through unchanged', () => {
    expect(toGatewayUrl('https://example.com/x.json')).toBe('https://example.com/x.json');
    expect(toGatewayUrl('/local/path')).toBe('/local/path');
  });
});

describe('sanitizeTokenMetadata', () => {
  it('returns null for non-objects and empty objects', () => {
    expect(sanitizeTokenMetadata(null)).toBeNull();
    expect(sanitizeTokenMetadata('x')).toBeNull();
    expect(sanitizeTokenMetadata({})).toBeNull();
  });

  it('keeps safe fields and drops junk types', () => {
    const meta = sanitizeTokenMetadata({
      name: '  Bridged USD Coin  ',
      description: 'A stablecoin',
      symbol: 'USDC',
      decimals: 6,
      tags: ['stablecoin', 'bridged', 'stablecoin', ''],
      origin: { chain: 'Ethereum', address: '0xabc' },
      links: { website: 'https://usdc.com', coingecko: 'ftp://nope' },
    });
    expect(meta).toEqual({
      name: 'Bridged USD Coin',
      description: 'A stablecoin',
      symbol: 'USDC',
      decimals: 6,
      tags: ['stablecoin', 'bridged'],
      origin: { chain: 'Ethereum', address: '0xabc' },
      links: { website: 'https://usdc.com' },
    });
  });

  it('caps text lengths', () => {
    const meta = sanitizeTokenMetadata({
      name: 'x'.repeat(500),
      description: 'y'.repeat(1000),
    });
    expect(meta?.name?.length).toBe(120);
    expect(meta?.description?.length).toBe(400);
  });

  it('caps the number of tags', () => {
    const meta = sanitizeTokenMetadata({
      tags: Array.from({ length: 20 }, (_, i) => `tag${i}`),
    });
    expect(meta?.tags).toHaveLength(8);
  });

  it('accepts gateway and same-origin icon URLs, rejects cross-origin protocol-relative', () => {
    expect(sanitizeTokenMetadata({ icon: 'ipfs://QmHash' })?.icon).toBe('/ipfs/QmHash');
    expect(sanitizeTokenMetadata({ logo_uri: 'ipfs://bafyLogo' })?.icon).toBe(
      '/ipfs/bafyLogo',
    );
    expect(sanitizeTokenMetadata({ icon: 'https://cdn.example/i.png' })?.icon).toBe(
      'https://cdn.example/i.png',
    );
    expect(sanitizeTokenMetadata({ icon: '//evil.example/i.png' })?.icon).toBeUndefined();
    expect(sanitizeTokenMetadata({ icon: 'javascript:alert(1)' })?.icon).toBeUndefined();
  });

  it('rejects out-of-range or non-integer decimals', () => {
    expect(sanitizeTokenMetadata({ decimals: 19 })?.decimals).toBeUndefined();
    expect(sanitizeTokenMetadata({ decimals: -1 })?.decimals).toBeUndefined();
    expect(sanitizeTokenMetadata({ decimals: 6.5 })?.decimals).toBeUndefined();
    expect(sanitizeTokenMetadata({ decimals: 18 })?.decimals).toBe(18);
  });

  it('rejects non-http links', () => {
    const meta = sanitizeTokenMetadata({
      links: { website: 'javascript:alert(1)', coingecko: 'https://coingecko.com/x' },
    });
    expect(meta?.links?.website).toBeUndefined();
    expect(meta?.links?.coingecko).toBe('https://coingecko.com/x');
  });
});

describe('resolveTokenMetadata', () => {
  const json = (body: unknown) => ({
    ok: true,
    status: 200,
    json: async () => body,
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves token info then metadata document, sanitized', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        json({ metadata_uri: { string: 'ipfs://QmMeta' } }),
      )
      .mockResolvedValueOnce(json({ name: 'Bridged Token', tags: ['bridged'] }));
    const meta = await resolveTokenMetadata('tid1', { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('/token/tid1'),
      { method: 'GET', headers: {} },
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      '/ipfs/QmMeta',
      { method: 'GET', headers: {} },
    );
    expect(meta?.name).toBe('Bridged Token');
  });

  it('returns null when the token info fetch fails', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('down'));
    expect(await resolveTokenMetadata('tid', { fetchImpl: fetchImpl as unknown as typeof fetch })).toBeNull();
  });

  it('returns null when there is no metadata URI', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({}));
    expect(await resolveTokenMetadata('tid', { fetchImpl: fetchImpl as unknown as typeof fetch })).toBeNull();
  });
});

describe('resolveTokenIcon', () => {
  it('returns the sanitized icon or null', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ icon_uri: { string: 'ipfs://QmIcon' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ icon: 'ipfs://QmReal' }),
      });
    expect(
      await resolveTokenIcon('tid', { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).toBe('/ipfs/QmReal');
  });
});
