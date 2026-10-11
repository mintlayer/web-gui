import { describe, it, expect } from 'vitest';
import { json } from './api-utils';

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
