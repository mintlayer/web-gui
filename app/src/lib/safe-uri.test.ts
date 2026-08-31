import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { safeExternalUri, getIpfsGateway } from '@/lib/safe-uri';

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
