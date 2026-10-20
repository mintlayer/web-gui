import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildCsp, connectSources } from './csp';

function cspConnectSrc(): string {
  const m = /connect-src ([^;]+);/.exec(buildCsp());
  return m?.[1] ?? '';
}

describe('csp connect-src derivation', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.CSP_CONNECT_EXTRA;
  });

  it('includes the default bridge, indexer (and their ws twins) plus coingecko', () => {
    const sources = cspConnectSrc().split(' ');
    expect(sources).toContain("'self'");
    expect(sources).toContain('https://api.bridge.mintlayer.org');
    expect(sources).toContain('wss://api.bridge.mintlayer.org');
    expect(sources).toContain('https://api-server.mintlayer.org');
    expect(sources).toContain('https://api.coingecko.com');
  });

  it('keeps every other directive unchanged', () => {
    expect(cspConnectSrc()).toContain("'self' https://api.coingecko.com");
    expect(buildCsp()).toContain("default-src 'self'");
    expect(buildCsp()).toContain("img-src 'self' https: data:");
    expect(buildCsp()).toContain("script-src 'self' 'unsafe-inline'");
    expect(buildCsp()).toContain("frame-ancestors 'none'");
    expect(buildCsp()).toContain("object-src 'none'");
  });

  it('follows PUBLIC_BRIDGE_API_URL overrides in both schemes', () => {
    // vi.stubEnv only writes process.env (see bridge-sdk/config.test.ts)
    // - which is exactly what the CSP builder reads for overrides.
    vi.stubEnv('PUBLIC_BRIDGE_API_URL', 'https://bridge.example/api/v1/');
    const sources = cspConnectSrc().split(' ');
    expect(sources).toContain('https://bridge.example');
    expect(sources).toContain('wss://bridge.example');
    expect(sources).not.toContain('https://api.bridge.mintlayer.org');
  });

  it('maps http overrides to ws for local mirrors', () => {
    vi.stubEnv('PUBLIC_MINTLAYER_API_URL', 'http://localhost:3000/api/v2/');
    const sources = cspConnectSrc().split(' ');
    expect(sources).toContain('http://localhost:3000');
    expect(sources).toContain('ws://localhost:3000');
  });

  it('adds only well-formed CSP_CONNECT_EXTRA origins', () => {
    process.env.CSP_CONNECT_EXTRA =
      'https://mirror.example, not-an-origin, javascript:alert(1), https://paths.example/with/path';
    const sources = cspConnectSrc().split(' ');
    expect(sources).toContain('https://mirror.example');
    expect(sources).not.toContain('not-an-origin');
    expect(sources).not.toContain('javascript:alert(1)');
    // Paths are rejected - an origin has no path component.
    expect(sources).not.toContain('https://paths.example/with/path');
  });

  it('deduplicates sources', () => {
    process.env.CSP_CONNECT_EXTRA = 'https://api.coingecko.com';
    const sources = connectSources();
    expect(sources.filter((s) => s === 'https://api.coingecko.com')).toHaveLength(1);
  });
});
