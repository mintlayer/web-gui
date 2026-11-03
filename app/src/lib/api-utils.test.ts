import { describe, it, expect } from 'vitest';
import { json, readFormWithinLimit, readJsonWithinLimit } from './api-utils';

describe('json()', () => {
  it('serializes the body with the JSON content type', async () => {
    const res = json({ ok: true }, 200);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(await res.json()).toEqual({ ok: true });
  });

  it('always sets Cache-Control: no-store (money/authed responses never cached)', () => {
    const res = json({ ok: true });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('lets callers add extra headers without dropping no-store', () => {
    const res = json({ ok: true }, 200, { 'X-Extra': '1' });
    expect(res.headers.get('X-Extra')).toBe('1');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('does not let callers override no-store', () => {
    const res = json({ ok: true }, 200, { 'Cache-Control': 'public' });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('body size limits (public POST endpoints)', () => {

  it('returns null for content-length over the cap (413 path)', async () => {
    const req = new Request('http://x.test/login', {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(2 << 20) }),
      body: 'a=1',
    });
    expect(await readFormWithinLimit(req, 1 << 20)).toBeNull();
  });

  it('parses a normal form body within the cap', async () => {
    const req = new Request('http://x.test/login', {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/x-www-form-urlencoded' }),
      body: 'password=hunter2&totp_code=123456',
    });
    const form = await readFormWithinLimit(req, 1 << 20);
    expect(form?.get('password')).toBe('hunter2');
  });

  it('caps chunked bodies without content-length', async () => {
    const big = 'x'.repeat(2 << 20);
    const stream = new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(big)); c.close(); },
    });
    const req = new Request('http://x.test/login', {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/x-www-form-urlencoded', 'transfer-encoding': 'chunked' }),
      body: stream,
      // @ts-expect-error duplex is valid at runtime for stream bodies
      duplex: 'half',
    });
    expect(await readFormWithinLimit(req, 1 << 20)).toBeNull();
  });

  it('parses a chunked body within the cap after re-buffering', async () => {
    const stream = new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode('password=ok')); c.close(); },
    });
    const req = new Request('http://x.test/login', {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/x-www-form-urlencoded', 'transfer-encoding': 'chunked' }),
      body: stream,
      // @ts-expect-error duplex is valid at runtime for stream bodies
      duplex: 'half',
    });
    const form = await readFormWithinLimit(req, 1 << 20);
    expect(form?.get('password')).toBe('ok');
  });

  it('returns null for oversized JSON and for malformed JSON', async () => {
    const big = new Request('http://x.test/api', {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json', 'content-length': String(128 << 10) }),
      body: '{"a":1}',
    });
    expect(await readJsonWithinLimit(big, 64 << 10)).toBeNull();
    const bad = new Request('http://x.test/api', {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: 'not json',
    });
    expect(await readJsonWithinLimit(bad, 64 << 10)).toBeNull();
  });
});
