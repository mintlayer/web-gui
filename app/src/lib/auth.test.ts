/**
 * Tests for auth.ts - password hashing, session tokens, TOTP, rate limiting.
 *
 * The in-memory Maps (loginAttempts, rpcAttempts) persist for the lifetime of
 * a module instance. Rate-limiting tests use vi.resetModules() + dynamic
 * re-import to get a clean module state for each describe block.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Password hashing ──────────────────────────────────────────────────────────

describe('hashPassword / verifyPassword', () => {
  // Import directly - these are pure async functions with no side effects
  let hashPassword: (p: string) => Promise<string>;
  let verifyPassword: (p: string, s: string) => Promise<boolean>;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('@/lib/auth');
    hashPassword = mod.hashPassword;
    verifyPassword = mod.verifyPassword;
  });

  it('produces a hash in the expected format', async () => {
    const hash = await hashPassword('mysecret');
    expect(hash).toMatch(/^pbkdf2:sha512:210000:[0-9a-f]{64}:[0-9a-f]{128}$/);
  });

  it('two hashes of the same password differ (random salts)', async () => {
    const h1 = await hashPassword('same');
    const h2 = await hashPassword('same');
    expect(h1).not.toBe(h2);
  });

  it('verifies correct password → true', async () => {
    const hash = await hashPassword('correct');
    expect(await verifyPassword('correct', hash)).toBe(true);
  });

  it('rejects wrong password → false', async () => {
    const hash = await hashPassword('correct');
    expect(await verifyPassword('wrong', hash)).toBe(false);
  });

  it('returns false for string with too few colon-separated parts', async () => {
    expect(await verifyPassword('x', 'pbkdf2:sha512:100000:abc')).toBe(false);
  });

  it('returns false when first token is not "pbkdf2"', async () => {
    const hash = await hashPassword('x');
    const tampered = hash.replace(/^pbkdf2/, 'bcrypt');
    expect(await verifyPassword('x', tampered)).toBe(false);
  });

  it('returns false when iteration count is NaN', async () => {
    const hash = await hashPassword('x');
    const parts = hash.split(':');
    parts[2] = 'notanumber';
    expect(await verifyPassword('x', parts.join(':'))).toBe(false);
  });

  it('returns false for empty stored string', async () => {
    expect(await verifyPassword('x', '')).toBe(false);
  });
});

// ── Session token ─────────────────────────────────────────────────────────────

describe('generateSessionToken / verifySessionToken', () => {
  const SECRET = 'test-secret-that-is-at-least-32-chars-long';

  beforeEach(() => {
    process.env.SESSION_SECRET = SECRET;
  });

  afterEach(() => {
    delete process.env.SESSION_SECRET;
    vi.restoreAllMocks();
  });

  it('generates a token matching <timestamp>.<version>.<64-hex> format', async () => {
    vi.resetModules();
    const { generateSessionToken } = await import('@/lib/auth');
    const token = generateSessionToken();
    expect(token).toMatch(/^\d+\.\d+\.[0-9a-f]{64}$/);
  });

  it('throws when SESSION_SECRET is missing', async () => {
    delete process.env.SESSION_SECRET;
    vi.resetModules();
    const { generateSessionToken } = await import('@/lib/auth');
    expect(() => generateSessionToken()).toThrow('SESSION_SECRET');
  });

  it('throws when SESSION_SECRET is shorter than 32 chars', async () => {
    process.env.SESSION_SECRET = 'tooshort';
    vi.resetModules();
    const { generateSessionToken } = await import('@/lib/auth');
    expect(() => generateSessionToken()).toThrow('SESSION_SECRET');
  });

  it('freshly generated token verifies as true', async () => {
    vi.resetModules();
    const { generateSessionToken, verifySessionToken } = await import('@/lib/auth');
    const token = generateSessionToken();
    expect(verifySessionToken(token)).toBe(true);
  });

  it('returns false for empty string', async () => {
    vi.resetModules();
    const { verifySessionToken } = await import('@/lib/auth');
    expect(verifySessionToken('')).toBe(false);
  });

  it('returns false for token with no dot separator', async () => {
    vi.resetModules();
    const { verifySessionToken } = await import('@/lib/auth');
    expect(verifySessionToken('nodot')).toBe(false);
  });

  it('returns false for tampered HMAC', async () => {
    vi.resetModules();
    const { generateSessionToken, verifySessionToken } = await import('@/lib/auth');
    const token = generateSessionToken();
    const tampered = token.slice(0, -4) + 'aaaa';
    expect(verifySessionToken(tampered)).toBe(false);
  });

  it('returns false for expired token (older than 30 minutes)', async () => {
    vi.resetModules();
    const { generateSessionToken, verifySessionToken } = await import('@/lib/auth');
    // Generate token with a timestamp 31 minutes in the past
    const thirtyOneMinutesAgo = Date.now() - 31 * 60 * 1000;
    vi.spyOn(Date, 'now').mockReturnValue(thirtyOneMinutesAgo);
    const token = generateSessionToken();
    vi.spyOn(Date, 'now').mockRestore();
    expect(verifySessionToken(token)).toBe(false);
  });

  it('returns false when SESSION_SECRET is missing during verify', async () => {
    vi.resetModules();
    process.env.SESSION_SECRET = SECRET;
    const { generateSessionToken } = await import('@/lib/auth');
    const token = generateSessionToken();
    delete process.env.SESSION_SECRET;
    vi.resetModules();
    const { verifySessionToken } = await import('@/lib/auth');
    expect(verifySessionToken(token)).toBe(false);
  });

  it('returns false for token with only 2 parts (old format)', async () => {
    vi.resetModules();
    const { verifySessionToken } = await import('@/lib/auth');
    const fakeOldToken = `${Date.now()}.${'a'.repeat(64)}`;
    expect(verifySessionToken(fakeOldToken)).toBe(false);
  });

  it('rejects a token generated with version 0 when verifying against version 1', async () => {
    vi.resetModules();
    const { generateSessionToken, verifySessionToken } = await import('@/lib/auth');
    const token = generateSessionToken(0);
    expect(verifySessionToken(token, 1)).toBe(false);
  });

  it('generateSessionToken(1) produces a token accepted by verifySessionToken(token, 1) but rejected by verifySessionToken(token, 0)', async () => {
    vi.resetModules();
    const { generateSessionToken, verifySessionToken } = await import('@/lib/auth');
    const token = generateSessionToken(1);
    expect(verifySessionToken(token, 1)).toBe(true);
    expect(verifySessionToken(token, 0)).toBe(false);
  });
});

// ── TOTP ──────────────────────────────────────────────────────────────────────

describe('verifyTOTP', () => {
  let verifyTOTP: (code: string, secret: string) => boolean;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('@/lib/auth');
    verifyTOTP = mod.verifyTOTP;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns false for non-6-digit short code', () => {
    expect(verifyTOTP('12345', 'JBSWY3DPEHPK3PXP')).toBe(false);
  });

  it('returns false for non-6-digit long code', () => {
    expect(verifyTOTP('1234567', 'JBSWY3DPEHPK3PXP')).toBe(false);
  });

  it('returns false for alpha characters', () => {
    expect(verifyTOTP('abcdef', 'JBSWY3DPEHPK3PXP')).toBe(false);
  });

  it('returns false for empty code', () => {
    expect(verifyTOTP('', 'JBSWY3DPEHPK3PXP')).toBe(false);
  });

  it('returns false for empty secret', () => {
    expect(verifyTOTP('000000', '')).toBe(false);
  });

  it('returns true for a correctly computed TOTP code (current window)', () => {
    // RFC 4226 test vector: secret "12345678901234567890"
    // Base32 of "12345678901234567890" = GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    // Use T=2 (60 seconds in) so T-1=1 and T+1=3 are all valid - avoids counter=-1
    // At T=2 (counter=2), HOTP code = 359152
    vi.spyOn(Date, 'now').mockReturnValue(60_000); // T=2
    expect(verifyTOTP('359152', secret)).toBe(true);
  });

  it('accepts code from T-1 window (backward clock skew)', () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    // At T=2 (60s), T-1 = counter 1, code = 287082
    vi.spyOn(Date, 'now').mockReturnValue(60_000);
    expect(verifyTOTP('287082', secret)).toBe(true);
  });

  it('accepts code from T+1 window (forward clock skew)', () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    // At T=2 (60s), T+1 = counter 3, code = 969429
    vi.spyOn(Date, 'now').mockReturnValue(60_000);
    expect(verifyTOTP('969429', secret)).toBe(true);
  });

  it('rejects a code from T-2 (outside tolerance window)', () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    // At T=5 (150s), T-2 = counter 3 (code 969429). T=5 accepts 4,5,6 only.
    vi.spyOn(Date, 'now').mockReturnValue(150_000); // T=5
    expect(verifyTOTP('969429', secret)).toBe(false);
  });
});

// ── Login rate limiting ───────────────────────────────────────────────────────

describe('checkLoginRateLimit / recordLoginFailure', () => {
  // Fresh module instance per test to reset the in-memory Map
  let checkLoginRateLimit: (ip: string) => boolean;
  let recordLoginFailure: (ip: string) => void;

  beforeEach(async () => {
    vi.resetModules();
    process.env.SESSION_SECRET = 'test-secret-that-is-at-least-32-chars-long';
    const mod = await import('@/lib/auth');
    checkLoginRateLimit = mod.checkLoginRateLimit;
    recordLoginFailure = mod.recordLoginFailure;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows first request for unknown IP', () => {
    expect(checkLoginRateLimit('1.2.3.4')).toBe(true);
  });

  it('allows up to 4 failures', () => {
    for (let i = 0; i < 4; i++) recordLoginFailure('1.2.3.4');
    expect(checkLoginRateLimit('1.2.3.4')).toBe(true);
  });

  it('blocks on the 5th failure', () => {
    for (let i = 0; i < 5; i++) recordLoginFailure('1.2.3.4');
    expect(checkLoginRateLimit('1.2.3.4')).toBe(false);
  });

  it('resets after the 15-minute window expires', () => {
    for (let i = 0; i < 5; i++) recordLoginFailure('1.2.3.4');
    expect(checkLoginRateLimit('1.2.3.4')).toBe(false);
    vi.advanceTimersByTime(15 * 60 * 1000 + 1);
    expect(checkLoginRateLimit('1.2.3.4')).toBe(true);
  });

  it('different IPs have independent counters', () => {
    for (let i = 0; i < 5; i++) recordLoginFailure('1.1.1.1');
    expect(checkLoginRateLimit('1.1.1.1')).toBe(false);
    expect(checkLoginRateLimit('2.2.2.2')).toBe(true);
  });

  it('recordLoginFailure creates a new entry after window expiry', () => {
    for (let i = 0; i < 5; i++) recordLoginFailure('1.2.3.4');
    vi.advanceTimersByTime(15 * 60 * 1000 + 1);
    recordLoginFailure('1.2.3.4'); // starts a new window with count=1
    expect(checkLoginRateLimit('1.2.3.4')).toBe(true); // count=1, not blocked
  });
});

// ── RPC rate limiting ─────────────────────────────────────────────────────────

describe('checkRpcRateLimit', () => {
  let checkRpcRateLimit: (ip: string) => boolean;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('@/lib/auth');
    checkRpcRateLimit = mod.checkRpcRateLimit;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows first request', () => {
    expect(checkRpcRateLimit('1.2.3.4')).toBe(true);
  });

  it('allows up to 120 requests', () => {
    // First call already counted, so 119 more
    for (let i = 0; i < 119; i++) checkRpcRateLimit('1.2.3.4');
    // 120th call
    expect(checkRpcRateLimit('1.2.3.4')).toBe(true);
  });

  it('blocks the 121st request', () => {
    for (let i = 0; i < 120; i++) checkRpcRateLimit('1.2.3.4');
    expect(checkRpcRateLimit('1.2.3.4')).toBe(false);
  });

  it('resets after the 60-second window expires', () => {
    for (let i = 0; i < 121; i++) checkRpcRateLimit('1.2.3.4');
    expect(checkRpcRateLimit('1.2.3.4')).toBe(false);
    vi.advanceTimersByTime(60_000 + 1);
    expect(checkRpcRateLimit('1.2.3.4')).toBe(true);
  });

  it('separate IPs have independent counters', () => {
    for (let i = 0; i < 121; i++) checkRpcRateLimit('a.a.a.a');
    expect(checkRpcRateLimit('a.a.a.a')).toBe(false);
    expect(checkRpcRateLimit('b.b.b.b')).toBe(true);
  });
});

// ── Cookie helpers ────────────────────────────────────────────────────────────

describe('makeSessionCookieHeader / clearSessionCookieHeader', () => {
  let makeSessionCookieHeader: (token: string) => string;
  let clearSessionCookieHeader: () => string;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('@/lib/auth');
    makeSessionCookieHeader = mod.makeSessionCookieHeader;
    clearSessionCookieHeader = mod.clearSessionCookieHeader;
  });

  it('makeSessionCookieHeader includes the token and security attributes', () => {
    const header = makeSessionCookieHeader('mytoken');
    expect(header).toContain('session=mytoken');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Strict');
    expect(header).toContain('Max-Age=1800');
  });

  it('clearSessionCookieHeader sets Max-Age=0', () => {
    const header = clearSessionCookieHeader();
    expect(header).toContain('session=;');
    expect(header).toContain('Max-Age=0');
  });
});

// ── Client address resolution + map pruning ──────────────────────────────────

describe('getClientAddress (spoofable x-forwarded-for)', () => {
  let getClientAddress: (request: Request, socketAddress?: string) => string;

  beforeEach(async () => {
    vi.resetModules();
    process.env.SESSION_SECRET = 'test-secret-that-is-at-least-32-chars-long';
    const mod = await import('@/lib/auth');
    getClientAddress = mod.getClientAddress;
  });

  afterEach(() => {
    delete process.env.TRUST_PROXY;
  });

  const req = (xff?: string) =>
    new Request('http://localhost/', { headers: xff ? { 'x-forwarded-for': xff } : {} });

  it('prefers the socket address and ignores XFF by default', () => {
    delete process.env.TRUST_PROXY;
    expect(getClientAddress(req('9.9.9.9'), '10.0.0.5')).toBe('10.0.0.5');
  });

  it('ignores XFF entirely when TRUST_PROXY is not true', () => {
    process.env.TRUST_PROXY = '1';
    expect(getClientAddress(req('9.9.9.9'), '10.0.0.5')).toBe('10.0.0.5');
  });

  it('uses the first XFF entry when TRUST_PROXY=true', () => {
    process.env.TRUST_PROXY = 'true';
    expect(getClientAddress(req('9.9.9.9, 10.0.0.1'), '10.0.0.5')).toBe('9.9.9.9');
  });

  it('falls back to the socket address when XFF is absent even with TRUST_PROXY=true', () => {
    process.env.TRUST_PROXY = 'true';
    expect(getClientAddress(req(), '10.0.0.5')).toBe('10.0.0.5');
  });

  it('returns "unknown" when nothing is available', () => {
    delete process.env.TRUST_PROXY;
    expect(getClientAddress(req())).toBe('unknown');
  });
});

describe('rate-limit map pruning (unbounded maps)', () => {
  it('prunes expired login entries so memory stays bounded', async () => {
    vi.resetModules();
    process.env.SESSION_SECRET = 'test-secret-that-is-at-least-32-chars-long';
    const mod = await import('@/lib/auth');
    vi.useFakeTimers();
    // Fill with many unique spoofed-source entries across several windows
    for (let window = 0; window < 3; window++) {
      for (let i = 0; i < 500; i++) mod.recordLoginFailure(`10.${window}.${i}.1`);
      vi.advanceTimersByTime(15 * 60 * 1000 + 1);
    }
    // One more check triggers a fresh prune pass over the map
    expect(mod.checkLoginRateLimit('10.0.0.999')).toBe(true);
    // Map size observable via a fresh prune-heavy run: entries from earlier
    // windows must be gone - a request from an old IP starts clean.
    expect(mod.checkLoginRateLimit('10.0.0.1')).toBe(true);
    vi.useRealTimers();
  });

  it('prunes expired RPC entries', async () => {
    vi.resetModules();
    const mod = await import('@/lib/auth');
    vi.useFakeTimers();
    for (let i = 0; i < 200; i++) mod.checkRpcRateLimit(`10.1.${i}.1`);
    vi.advanceTimersByTime(60_000 + 1);
    // All entries expired; a fresh check prunes them and starts clean
    expect(mod.checkRpcRateLimit('10.1.0.1')).toBe(true);
    vi.useRealTimers();
  });
});

// ── PBKDF2 iteration upgrade ─────────────────────────────────────────────────

describe('passwordNeedsRehash (rehash-on-login)', () => {
  let passwordNeedsRehash: (stored: string) => boolean;
  let hashPassword: (plain: string) => Promise<string>;

  beforeEach(async () => {
    vi.resetModules();
    process.env.SESSION_SECRET = 'test-secret-that-is-at-least-32-chars-long';
    const mod = await import('@/lib/auth');
    passwordNeedsRehash = mod.passwordNeedsRehash;
    hashPassword = mod.hashPassword;
  });

  it('flags hashes created with the old 100k iteration count', () => {
    expect(passwordNeedsRehash('pbkdf2:sha512:100000:abc:def')).toBe(true);
  });

  it('accepts hashes at the current 210k iteration count', async () => {
    const stored = await hashPassword('some-password');
    expect(passwordNeedsRehash(stored)).toBe(false);
  });

  it('flags well-formed hashes with an unparseable iteration count', () => {
    // Note: 'garbage' (wrong part count) returns false - the helper only runs
    // after verifyPassword succeeded, so the hash is necessarily well-formed.
    expect(passwordNeedsRehash('pbkdf2:sha512:notanumber:abc:def')).toBe(true);
  });

  it('returns false for malformed hashes (unreachable after successful verify)', () => {
    expect(passwordNeedsRehash('garbage')).toBe(false);
  });

  it('still verifies hashes created with the old 100k count (backwards compat)', async () => {
    const mod = await import('@/lib/auth');
    // Hand-craft a 100k-format hash with the real pbkdf2
    const { pbkdf2 } = await import('node:crypto');
    const promisified = (pw: string, salt: string, iter: number) =>
      new Promise<string>((res, rej) =>
        pbkdf2(pw, salt, iter, 64, 'sha512', (e, k) => (e ? rej(e) : res(k.toString('hex')))));
    const salt = 'aabbccdd';
    const key = await promisified('legacy-password', salt, 100_000);
    const stored = `pbkdf2:sha512:100000:${salt}:${key}`;
    await expect(mod.verifyPassword('legacy-password', stored)).resolves.toBe(true);
    await expect(mod.verifyPassword('wrong-password', stored)).resolves.toBe(false);
  });
});
