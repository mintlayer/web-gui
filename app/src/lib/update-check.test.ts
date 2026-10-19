import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  compareVersions,
  parseBitcoindMarker,
  checkForUpdate,
  clearUpdateCache,
  CURRENT_VERSION,
} from './update-check';

/** Raw GitHub releases-API wire shape. */
function wire(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tag_name: 'v1.0.0',
    name: 'v1.0.0',
    body: 'release notes',
    prerelease: false,
    html_url: 'https://github.com/mintlayer/web-gui/releases/tag/v1.0.0',
    published_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

describe('compareVersions', () => {
  it('orders core fields numerically', () => {
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.1', '1.0.0')).toBe(1);
    expect(compareVersions('1.0.0', '1.2.0')).toBe(-1);
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
  });

  it('ranks a final release above any pre-release of the same core', () => {
    expect(compareVersions('1.0.0', '1.0.0-rc3')).toBe(1);
    expect(compareVersions('1.0.0-rc3', '1.0.0')).toBe(-1);
  });

  it('ranks rc numbers numerically', () => {
    expect(compareVersions('1.0.0-rc3', '1.0.0-rc2')).toBe(1);
    expect(compareVersions('1.0.0-rc10', '1.0.0-rc9')).toBe(1);
  });

  it('tolerates a v prefix and missing fields', () => {
    expect(compareVersions('v1.1', '1.0.9')).toBe(1);
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
  });
});

describe('parseBitcoindMarker', () => {
  it('reads the machine-readable marker', () => {
    expect(parseBitcoindMarker('## Highlights\n\nbitcoind: 26.0\n')).toBe('26.0');
    expect(parseBitcoindMarker('<!-- bitcoind: 27 -->')).toBe('27');
    expect(parseBitcoindMarker('bitcoind:\t26.1')).toBe('26.1');
  });

  it('returns null without a marker', () => {
    expect(parseBitcoindMarker('no core changes here')).toBeNull();
    expect(parseBitcoindMarker('bitcoind: coming soon')).toBeNull();
  });

  it('ignores markers embedded in prose rather than on their own line', () => {
    expect(parseBitcoindMarker('we fixed the frobbitcoind: 26.0 bug')).toBeNull();
    expect(parseBitcoindMarker('compatible with bitcoind: 25.x and 26.x')).toBeNull();
    expect(parseBitcoindMarker('## Notes\nas announced, bitcoind: 26.0 ships today')).toBeNull();
  });

  it('rejects marker values that are too long or malformed', () => {
    expect(parseBitcoindMarker('bitcoind: 26.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0')).toBeNull();
    expect(parseBitcoindMarker('bitcoind: -26')).toBeNull();
  });
});

describe('checkForUpdate', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    clearUpdateCache();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  function respond(releases: unknown[]) {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(releases), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }

  it('reports an update when a newer release exists', async () => {
    respond([
      wire({ tag_name: 'v9.9.9', html_url: 'https://github.com/mintlayer/web-gui/releases/tag/v9.9.9' }),
      wire({ tag_name: 'v0.1.0', html_url: 'https://github.com/mintlayer/web-gui/releases/tag/v0.1.0' }),
    ]);
    const status = await checkForUpdate(false);
    expect(status.available).toBe(true);
    expect(status.latest?.tag).toBe('v9.9.9');
    expect(status.current).toBe(CURRENT_VERSION);
  });

  it('reports up to date when nothing newer exists', async () => {
    respond([wire({ tag_name: 'v0.0.1', html_url: 'https://github.com/mintlayer/web-gui/releases/tag/v0.0.1' })]);
    const status = await checkForUpdate(false);
    expect(status.available).toBe(false);
  });

  it('skips pre-releases unless requested', async () => {
    respond([wire({ tag_name: 'v9.9.9-rc1', prerelease: true })]);
    expect((await checkForUpdate(false)).available).toBe(false);
    expect((await checkForUpdate(true)).available).toBe(true);
  });

  it('extracts the declared bitcoind version from the notes', async () => {
    respond([wire({ tag_name: 'v9.9.9', body: '## Notes\nbitcoind: 26.0\n' })]);
    const status = await checkForUpdate(false);
    expect(status.latest?.bitcoind).toBe('26.0');
  });

  it('throws on a non-JSON body instead of parsing garbage', async () => {
    fetchMock.mockResolvedValue(
      new Response('<html>rate limited</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );
    await expect(checkForUpdate(false)).rejects.toThrow();
  });

  it('throws on HTTP failure', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 503 }));
    await expect(checkForUpdate(false)).rejects.toThrow('HTTP 503');
  });

  it('ignores entries with malformed tags or non-https urls', async () => {
    respond([
      wire({ tag_name: 'not-a-tag' }),
      wire({ tag_name: 'v1x' }),
      { tag_name: 'v8.8.8', body: 42, html_url: 'http://evil.example/x', prerelease: false },
      wire({ tag_name: 'v8.8.8', html_url: 'javascript:alert(1)' }),
    ]);
    const status = await checkForUpdate(false);
    expect(status.available).toBe(true);
    expect(status.latest?.tag).toBe('v8.8.8');
  });
});
