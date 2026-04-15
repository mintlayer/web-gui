import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/prefs-db', () => ({
  getPref: vi.fn(),
  setPref: vi.fn(),
}));

import {
  getCredentials,
  saveCredentials,
  createChallenge,
  consumeChallenge,
  isValidRpId,
  getRpId,
  getOrigin,
  makeChallengeCookieHeader,
  clearChallengeCookieHeader,
  PASSKEY_CHALLENGE_COOKIE,
} from '@/lib/passkey';
import { getPref, setPref } from '@/lib/prefs-db';

beforeEach(() => {
  vi.mocked(getPref).mockReset();
  vi.mocked(setPref).mockReset();
  delete process.env.PASSKEY_RP_ID;
  delete process.env.PASSKEY_ORIGIN;
});

// ── getCredentials / saveCredentials ──────────────────────────────────────────

describe('getCredentials', () => {
  it('returns empty array when no prefs stored', () => {
    vi.mocked(getPref).mockReturnValue(null);
    expect(getCredentials()).toEqual([]);
  });

  it('returns stored credentials', () => {
    const creds = [{ id: 'abc', publicKey: 'pk', counter: 0, name: 'test', createdAt: 1 }];
    vi.mocked(getPref).mockReturnValue(creds);
    expect(getCredentials()).toEqual(creds);
  });
});

describe('saveCredentials', () => {
  it('calls setPref with auth.passkeys key', () => {
    const creds = [{ id: 'abc', publicKey: 'pk', counter: 0, name: 'test', createdAt: 1 }];
    saveCredentials(creds);
    expect(setPref).toHaveBeenCalledWith('auth.passkeys', creds);
  });
});

// ── Challenge store ───────────────────────────────────────────────────────────

describe('createChallenge / consumeChallenge', () => {
  it('stores a challenge and returns it on consume', () => {
    const token = createChallenge('challenge-abc');
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);
    const result = consumeChallenge(token);
    expect(result).toBe('challenge-abc');
  });

  it('returns null for unknown token', () => {
    expect(consumeChallenge('no-such-token')).toBeNull();
  });

  it('is single-use — second consume returns null', () => {
    const token = createChallenge('one-time');
    consumeChallenge(token);
    expect(consumeChallenge(token)).toBeNull();
  });

  it('returns null for expired challenge', () => {
    vi.useFakeTimers();
    const token = createChallenge('expiring');
    // Advance 6 minutes past the 5-minute TTL
    vi.advanceTimersByTime(6 * 60 * 1000);
    expect(consumeChallenge(token)).toBeNull();
    vi.useRealTimers();
  });

  it('generates unique tokens for different challenges', () => {
    const t1 = createChallenge('c1');
    const t2 = createChallenge('c2');
    expect(t1).not.toBe(t2);
  });
});

// ── isValidRpId ───────────────────────────────────────────────────────────────

describe('isValidRpId', () => {
  it('accepts localhost', () => {
    expect(isValidRpId('localhost')).toBe(true);
  });

  it('accepts a proper DNS hostname', () => {
    expect(isValidRpId('wallet.example.com')).toBe(true);
    expect(isValidRpId('mynode.duckdns.org')).toBe(true);
  });

  it('rejects IPv4 addresses', () => {
    expect(isValidRpId('192.168.1.1')).toBe(false);
    expect(isValidRpId('10.0.0.1')).toBe(false);
    expect(isValidRpId('1.2.3.4')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidRpId('')).toBe(false);
  });
});

// ── getRpId / getOrigin ───────────────────────────────────────────────────────

describe('getRpId', () => {
  it('returns PASSKEY_RP_ID env var when set', () => {
    process.env.PASSKEY_RP_ID = 'wallet.example.com';
    expect(getRpId('http://localhost:4321')).toBe('wallet.example.com');
  });

  it('derives hostname from request URL when env var is not set', () => {
    expect(getRpId('http://localhost:4321/api/passkey/auth-options')).toBe('localhost');
  });

  it('derives correct hostname from a DNS URL', () => {
    expect(getRpId('https://wallet.example.com/api/passkey/auth-options')).toBe('wallet.example.com');
  });
});

describe('getOrigin', () => {
  it('returns PASSKEY_ORIGIN env var when set', () => {
    process.env.PASSKEY_ORIGIN = 'https://wallet.example.com';
    expect(getOrigin('http://localhost:4321')).toBe('https://wallet.example.com');
  });

  it('derives origin from request URL when env var is not set', () => {
    expect(getOrigin('http://localhost:4321/api/passkey/auth-verify')).toBe('http://localhost:4321');
  });
});

// ── Cookie header helpers ─────────────────────────────────────────────────────

describe('makeChallengeCookieHeader', () => {
  it('includes the token value', () => {
    const header = makeChallengeCookieHeader('mytoken');
    expect(header).toContain(`${PASSKEY_CHALLENGE_COOKIE}=mytoken`);
  });

  it('sets HttpOnly and SameSite=Strict', () => {
    const header = makeChallengeCookieHeader('x');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Strict');
  });

  it('sets Max-Age=300', () => {
    const header = makeChallengeCookieHeader('x');
    expect(header).toContain('Max-Age=300');
  });
});

describe('clearChallengeCookieHeader', () => {
  it('sets Max-Age=0 to expire the cookie', () => {
    expect(clearChallengeCookieHeader()).toContain('Max-Age=0');
  });

  it('uses the correct cookie name', () => {
    expect(clearChallengeCookieHeader()).toContain(`${PASSKEY_CHALLENGE_COOKIE}=`);
  });
});
