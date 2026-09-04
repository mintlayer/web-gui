import { describe, it, expect } from 'vitest';
import { expectedOrigin, isForbiddenCrossSiteRequest } from '@/lib/csrf';

const BASE = 'http://web-gui:4321/login';

function req(
  method: string,
  headers: Record<string, string> = {},
  url = BASE,
): Request {
  return new Request(url, { method, headers });
}

describe('expectedOrigin', () => {
  it('uses the request URL when no proxy headers are present', () => {
    expect(expectedOrigin(req('POST', { host: 'localhost:4321' }))).toBe('http://localhost:4321');
  });

  it('honors X-Forwarded-Proto/Host (first value) behind a TLS proxy', () => {
    expect(
      expectedOrigin(
        req('POST', {
          host: 'ml1.local',
          'x-forwarded-proto': 'https',
          'x-forwarded-for': '192.168.1.10, 10.0.0.1',
        }),
      ),
    ).toBe('https://ml1.local');
  });

  it('honors X-Forwarded-Host even without X-Forwarded-Proto (scheme falls back to socket)', () => {
    expect(expectedOrigin(req('POST', { host: 'localhost:4321', 'x-forwarded-host': 'ml1.local' }))).toBe(
      'http://ml1.local',
    );
  });
});

describe('isForbiddenCrossSiteRequest', () => {
  it('allows same-origin form POST', () => {
    const r = req('POST', {
      origin: 'https://ml1.local',
      'content-type': 'application/x-www-form-urlencoded',
      host: 'ml1.local',
      'x-forwarded-proto': 'https',
    });
    expect(isForbiddenCrossSiteRequest(r)).toBe(false);
  });

  it('forbids cross-origin form POST (the Caddy scheme-mismatch case)', () => {
    const r = req('POST', {
      origin: 'https://ml1.local',
      'content-type': 'application/x-www-form-urlencoded',
      host: 'ml1.local',
      // no x-forwarded-proto: app derives http -> mismatch, like Astro did
    });
    expect(isForbiddenCrossSiteRequest(r)).toBe(true);
  });

  it('forbids cross-site text/plain POSTs (CORS-safelisted, no preflight)', () => {
    const r = req('POST', {
      origin: 'https://evil.example',
      'content-type': 'text/plain',
      host: 'ml1.local',
      'x-forwarded-proto': 'https',
    });
    expect(isForbiddenCrossSiteRequest(r)).toBe(true);
  });

  it('forbids cross-site multipart POSTs', () => {
    const r = req('POST', {
      origin: 'https://evil.example',
      'content-type': 'multipart/form-data; boundary=x',
      host: 'ml1.local',
      'x-forwarded-proto': 'https',
    });
    expect(isForbiddenCrossSiteRequest(r)).toBe(true);
  });

  it('matches origins case-insensitively on scheme (HTTPS proxy header)', () => {
    const r = req('POST', {
      origin: 'https://ml1.local',
      'content-type': 'application/x-www-form-urlencoded',
      host: 'ml1.local',
      'x-forwarded-proto': 'HTTPS',
    });
    expect(isForbiddenCrossSiteRequest(r)).toBe(false);
  });

  it('allows safe methods regardless of origin', () => {
    const r = req('GET', { origin: 'https://evil.example' });
    expect(isForbiddenCrossSiteRequest(r)).toBe(false);
  });

  it('allows non-form content types (API JSON calls) with matching origin', () => {
    const r = req('POST', {
      origin: 'https://ml1.local',
      'content-type': 'application/json',
      host: 'ml1.local',
      'x-forwarded-proto': 'https',
    });
    expect(isForbiddenCrossSiteRequest(r)).toBe(false);
  });

  it('forbids origin-less form POSTs, mirroring Astro semantics', () => {
    const r = req('POST', {
      'content-type': 'multipart/form-data; boundary=x',
      host: 'localhost:4321',
    });
    expect(isForbiddenCrossSiteRequest(r)).toBe(true);
  });

  it('allows origin-less JSON POSTs, mirroring Astro semantics', () => {
    const r = req('POST', { 'content-type': 'application/json', host: 'localhost:4321' });
    expect(isForbiddenCrossSiteRequest(r)).toBe(false);
  });

  it('matches over the plain SSH-tunnel path (localhost, no proxy)', () => {
    const r = new Request('http://localhost:4321/login', {
      method: 'POST',
      headers: {
        origin: 'http://localhost:4321',
        'content-type': 'application/x-www-form-urlencoded',
        host: 'localhost:4321',
      },
    });
    expect(isForbiddenCrossSiteRequest(r)).toBe(false);
  });
});
