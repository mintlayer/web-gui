/**
 * Tests for bridge-sdk/config.ts.
 *
 * NOTE on the public fallback operands (`env.PUBLIC_BRIDGE_API_URL` etc.):
 * `env` is captured from `import.meta.env` at module-evaluation time, and in
 * vitest that object is snapshotted from the worker's environment at spawn.
 * `vi.stubEnv` only writes `process.env` (verified against vitest 3.2.7
 * sources), so a *set* PUBLIC_* value cannot be simulated at runtime here -
 * that operand is exercised in deployments/builds that define the var. In the
 * plain test environment it is `undefined`, so these tests drive every line
 * through the `process.env` override and the `||`/`??` chain resolving to the
 * documented defaults.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  DEFAULT_BRIDGE_API_URL,
  DEFAULT_MINTLAYER_API_URL,
} from '@/lib/bridge-sdk/config';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('getServerBridgeApiUrl', () => {
  it('returns the trimmed process.env.BRIDGE_API_URL when set', async () => {
    vi.stubEnv('BRIDGE_API_URL', '  https://internal.example/api/v1/  ');
    vi.resetModules();
    const { getServerBridgeApiUrl } = await import('@/lib/bridge-sdk/config');
    // the server-side override wins and is trimmed - surrounding whitespace
    // must never leak into request URLs
    expect(getServerBridgeApiUrl()).toBe('https://internal.example/api/v1/');
  });

  it('falls back to the default URL when BRIDGE_API_URL is unset or blank', async () => {
    // whitespace-only trims to '' which is falsy, so the || chain falls
    // through the (undefined in tests) public var to the default
    vi.stubEnv('BRIDGE_API_URL', '   ');
    vi.resetModules();
    const { getServerBridgeApiUrl } = await import('@/lib/bridge-sdk/config');
    expect(getServerBridgeApiUrl()).toBe(DEFAULT_BRIDGE_API_URL);
  });

  it('does not throw when BRIDGE_API_URL is completely absent from the environment', async () => {
    vi.stubEnv('BRIDGE_API_URL', undefined);
    vi.resetModules();
    const { getServerBridgeApiUrl } = await import('@/lib/bridge-sdk/config');
    expect(getServerBridgeApiUrl()).toBe(DEFAULT_BRIDGE_API_URL);
  });
});

describe('getBridgeApiUrl', () => {
  it('falls back to the default URL when no public var is defined', async () => {
    vi.resetModules();
    const { getBridgeApiUrl } = await import('@/lib/bridge-sdk/config');
    expect(getBridgeApiUrl()).toBe(DEFAULT_BRIDGE_API_URL);
  });
});

describe('getMintlayerApiUrl', () => {
  it('falls back to the default URL when no public var is defined', async () => {
    vi.resetModules();
    const { getMintlayerApiUrl } = await import('@/lib/bridge-sdk/config');
    expect(getMintlayerApiUrl()).toBe(DEFAULT_MINTLAYER_API_URL);
  });
});
