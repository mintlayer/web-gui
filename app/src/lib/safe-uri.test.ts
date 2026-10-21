import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { safeExternalUri, safeImageUri, getIpfsGateway, safeRelativePath } from '@/lib/safe-uri';

describe('safeRelativePath (login next= redirect)', () => {
  it('keeps same-origin relative paths', () => {
    expect(safeRelativePath('/balances')).toBe('/balances');
    expect(safeRelativePath('/management/transactions?tab=history')).toBe('/management/transactions?tab=history');
  });

  it('rejects protocol-relative and backslash forms', () => {
    expect(safeRelativePath('//evil.com')).toBe('/');
    expect(safeRelativePath('/\\evil.com')).toBe('/');
    expect(safeRelativePath('https://evil.com')).toBe('/');
  });

  it('rejects control characters that undici refuses in header values', () => {
    // A crafted ?next= with CR/LF used to reach the Location header and
    // crash the login POST with an unhandled 500 after session minting.
    expect(safeRelativePath('/foo\r\nbar')).toBe('/');
    expect(safeRelativePath('/foo\nbar')).toBe('/');
    expect(safeRelativePath('/foo\x00bar')).toBe('/');
    expect(safeRelativePath('/foo\x7fbar')).toBe('/');
  });

  it('rejects non-ASCII code points that undici refuses in header values', () => {
    // undici rejects any ByteString above U+00FF, so U+2028 (survives URL
    // encoding as %E2%80%A8) crashed the redirect after irreversible side
    // effects - guard is printable-ASCII only, which subsumes the controls.
    expect(safeRelativePath('/foo\u2028bar')).toBe('/');
    expect(safeRelativePath('/foo\u00e9bar')).toBe('/');
  });
});

describe('safeExternalUri (javascript: URI sink)', () => {
  it('allows https: URLs through unchanged', () => {
    expect(safeExternalUri('https://example.com/token')).toBe('https://example.com/token');
  });

  it('blocks javascript: URIs', () => {
    expect(safeExternalUri('javascript:alert(document.cookie)')).toBeNull();
  });

  it('blocks data: URIs', () => {
    expect(safeExternalUri('data:text/html,<script>alert(1)</script>')).toBeNull();
  });

  it('blocks vbscript: and unknown schemes', () => {
    expect(safeExternalUri('vbscript:msgbox(1)')).toBeNull();
    expect(safeExternalUri('ftp://example.com/file')).toBeNull();
  });

  it('blocks plain http: (insecure downgrade)', () => {
    expect(safeExternalUri('http://example.com/token')).toBeNull();
  });

  it('returns null for unparseable garbage', () => {
    expect(safeExternalUri('not a url at all')).toBeNull();
    expect(safeExternalUri('')).toBeNull();
  });

  it('maps ipfs:// CID URIs to the gateway', () => {
    expect(safeExternalUri('ipfs://bafybeiabc123')).toBe('https://ipfs.io/ipfs/bafybeiabc123');
  });

  it('maps ipfs:// CID + path URIs to the gateway', () => {
    expect(safeExternalUri('ipfs://bafybeiabc123/metadata.json'))
      .toBe('https://ipfs.io/ipfs/bafybeiabc123/metadata.json');
  });

  it('rejects ipfs: URIs without a CID', () => {
    expect(safeExternalUri('ipfs://')).toBeNull();
  });

  it('honors PUBLIC_IPFS_GATEWAY', () => {
    process.env.PUBLIC_IPFS_GATEWAY = 'https://mygateway.example/ipfs';
    expect(getIpfsGateway()).toBe('https://mygateway.example/ipfs/');
    expect(safeExternalUri('ipfs://QmTest/x')).toBe('https://mygateway.example/ipfs/QmTest/x');
  });

  beforeEach(() => delete process.env.PUBLIC_IPFS_GATEWAY);
  afterEach(() => delete process.env.PUBLIC_IPFS_GATEWAY);
});

describe('safeImageUri (<img src> sink)', () => {
  it('allows https: image URLs', () => {
    expect(safeImageUri('https://cdn.example/icon.png')).toBe('https://cdn.example/icon.png');
  });

  it('allows same-origin gateway paths (bridge-sdk metadata pipeline)', () => {
    expect(safeImageUri('/ipfs/QmTest')).toBe('/ipfs/QmTest');
    expect(safeImageUri('  /ipfs/bafyabc/icon.png  ')).toBe('/ipfs/bafyabc/icon.png');
  });

  it('rejects protocol-relative and backslash path forms', () => {
    // '//' would be a cross-origin URL; backslashes can smuggle a host.
    expect(safeImageUri('//evil.example/icon.png')).toBeNull();
    expect(safeImageUri('/\\evil.example')).toBeNull();
  });

  it('maps ipfs:// URIs through the gateway', () => {
    expect(safeImageUri('ipfs://QmTest/icon.png')).toBe('https://ipfs.io/ipfs/QmTest/icon.png');
  });

  it('allows strict data:image/ URIs (self-contained, no network fetch)', () => {
    expect(safeImageUri('data:image/png;base64,iVBORw0KGgo=')).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(safeImageUri('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg"/>')).toBeTruthy();
  });

  it('blocks non-image data: URIs and data: lookalikes', () => {
    expect(safeImageUri('data:text/html;base64,PHNjcmlwdD4=')).toBeNull();
    expect(safeImageUri('data:image')).toBeNull();
    expect(safeImageUri('dataimage/png')).toBeNull();
  });

  it('blocks http:, javascript:, vbscript: and garbage (no mixed content, no scheme tricks)', () => {
    expect(safeImageUri('http://tracker.example/pixel?t=1')).toBeNull();
    expect(safeImageUri('javascript:alert(1)')).toBeNull();
    expect(safeImageUri('vbscript:x')).toBeNull();
    expect(safeImageUri('   ')).toBeNull();
    expect(safeImageUri('not a url')).toBeNull();
  });
});
