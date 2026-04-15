import { useState, useEffect } from 'react';
import { submitWithToast } from '@/lib/toastStore';
import { watchTx } from '@/lib/txWatcher';
import { CopyButton } from '@/components/CopyButton';

type Mode = 'easy' | 'expert';

interface Props {
  ipfsEnabled: boolean;
  onClose: () => void;
  onIssued?: (tokenId: string) => void;
}

async function rpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const res = await fetch('/api/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params }),
  });
  const data = await res.json() as { ok: boolean; result?: T; error?: { message: string } };
  if (!data.ok) throw new Error(data.error?.message ?? 'RPC error');
  return data.result as T;
}

/** Encode a UTF-8 string as a lowercase hex string for the Mintlayer RPC `{ hex }` format. */
function toHexField(str: string): { hex: string } {
  const bytes = new TextEncoder().encode(str);
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return { hex };
}

/** Strip non-alphanumeric characters and enforce max byte length (chain constraint). */
function sanitize(str: string, maxLen: number): string {
  return str.replace(/[^a-zA-Z0-9]/g, '').slice(0, maxLen);
}

const NAME_MAX = 10;
const DESC_MAX = 100;

async function sha256Hex(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function uploadToIPFS(file: File): Promise<string> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch('/api/ipfs-upload', { method: 'POST', body: form });
  const data = await res.json() as { ok: boolean; url?: string; error?: { message: string } };
  if (!data.ok) throw new Error(data.error?.message ?? 'Upload failed');
  return data.url!;
}

export default function IssueNFTModal({ ipfsEnabled, onClose, onIssued }: Props) {
  const [mode, setMode] = useState<Mode>('easy');

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [ticker, setTicker] = useState('');
  const [destAddress, setDestAddress] = useState('');

  // Media
  const [mediaHash, setMediaHash] = useState('');
  const [mediaUri, setMediaUri] = useState('');
  const [mediaUploading, setMediaUploading] = useState(false);
  const [mediaFile, setMediaFile] = useState<File | null>(null);

  // Icon
  const [iconUri, setIconUri] = useState('');
  const [iconUploading, setIconUploading] = useState(false);
  const [iconFile, setIconFile] = useState<File | null>(null);  // easy mode

  // Expert only
  const [additionalMetaUri, setAdditionalMetaUri] = useState('');

  const [error, setError] = useState<string | null>(null);
  const [issuedTokenId, setIssuedTokenId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Pre-fill destination address with first unused address on mount
  useEffect(() => {
    rpc<{ address: string; used: boolean }[]>('address_show', { account: 0, include_change_addresses: false })
      .then(addrs => {
        const first = addrs.find(a => !a.used) ?? addrs[addrs.length - 1];
        if (first) setDestAddress(first.address);
      })
      .catch(() => { /* leave blank */ });
  }, []);

  async function handleMediaFile(file: File) {
    setMediaUploading(true);
    setMediaFile(file);
    setMediaHash('');
    setMediaUri('');
    setError(null);
    try {
      const hashPromise = sha256Hex(file);
      const uploadPromise = ipfsEnabled ? uploadToIPFS(file) : Promise.resolve('');
      const [hash, url] = await Promise.all([hashPromise, uploadPromise]);
      if (ipfsEnabled && !url) {
        throw new Error('IPFS upload succeeded but returned no URL — cannot proceed without media URI');
      }
      // Chain max is 32 bytes; SHA-256 hex is 64 chars → truncate to 32
      setMediaHash(hash.slice(0, 32));
      if (url) setMediaUri(url);
    } catch (err) {
      setError(`Media upload failed: ${(err as Error).message}`);
      // Leave mediaHash empty so the submit button stays disabled
    } finally {
      setMediaUploading(false);
    }
  }

  async function handleIconFile(file: File) {
    setIconUploading(true);
    setIconFile(file);
    setError(null);
    try {
      const url = await uploadToIPFS(file);
      setIconUri(url);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIconUploading(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      // Abort if IPFS is enabled, a media file was selected, but upload didn't produce a URI.
      if (ipfsEnabled && mediaFile && !mediaUri) {
        throw new Error('Media file was not uploaded to IPFS. Re-select the file to retry.');
      }

      let newTokenId = '';
      await submitWithToast(async () => {
        // On-chain description must be alphanumeric only
        const onChainDescription = sanitize(description, DESC_MAX);

        // Easy mode: if the full description has extra content or IPFS is available,
        // upload a rich metadata JSON so the full description is preserved off-chain
        let resolvedAdditionalMetaUri = additionalMetaUri;
        if (mode === 'easy' && ipfsEnabled && description) {
          const meta: Record<string, string> = { name, description };
          const blob = new Blob([JSON.stringify(meta)], { type: 'application/json' });
          resolvedAdditionalMetaUri = await uploadToIPFS(new File([blob], 'metadata.json', { type: 'application/json' }));
        }

        const res = await rpc<{ token_id: string; tx_id: string }>('token_nft_issue_new', {
          account: 0,
          destination_address: destAddress,
          metadata: {
            media_hash: mediaHash,
            name: toHexField(name),
            description: toHexField(onChainDescription),
            ticker,
            creator: null,
            icon_uri: iconUri ? toHexField(iconUri) : null,
            media_uri: mediaUri ? toHexField(mediaUri) : null,
            additional_metadata_uri: resolvedAdditionalMetaUri ? toHexField(resolvedAdditionalMetaUri) : null,
          },
          options: {},
        });
        newTokenId = res.token_id;
        return res.tx_id;
      }, watchTx);
      setIssuedTokenId(newTokenId);
      onIssued?.(newTokenId);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  if (issuedTokenId) {
    return (
      <Overlay onClose={onClose}>
        <div className="px-6 py-8 text-center">
          <div className="w-12 h-12 rounded-full bg-green-900/40 border border-green-700 flex items-center justify-center mx-auto mb-4 text-xl">✓</div>
          <h2 className="text-lg font-semibold text-gray-100 mb-2">NFT Issued!</h2>
          <p className="text-sm text-gray-400 mb-4">Your new NFT token ID:</p>
          <span className="inline-flex items-center gap-1 flex-wrap justify-center">
            <code className="block rounded bg-gray-800 px-3 py-2 text-xs font-mono text-mint-400 break-all">{issuedTokenId}</code>
            <CopyButton value={issuedTokenId} title="Copy token ID" />
          </span>
          <p className="text-xs text-gray-500 mt-3">NFT will appear in your wallet once the transaction is confirmed.</p>
          <button onClick={onClose} className="mt-6 rounded-lg bg-mint-700 hover:bg-mint-600 px-6 py-2 text-sm font-semibold text-white transition-colors">
            Close
          </button>
        </div>
      </Overlay>
    );
  }

  return (
    <Overlay onClose={onClose}>
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800 shrink-0">
        <h2 className="text-base font-semibold text-gray-100">Mint NFT</h2>
        <div className="flex items-center gap-3">
          <ModeToggle mode={mode} onChange={setMode} />
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-xl leading-none">✕</button>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="overflow-y-auto flex-1">
        <div className="px-6 py-4 space-y-4">

          <div>
            <div className="flex justify-between items-baseline mb-1">
              <label className="text-xs text-gray-400">Name <span className="text-red-400">*</span></label>
              <span className={`text-xs ${name.length >= NAME_MAX ? 'text-red-400' : 'text-gray-600'}`}>{name.length}/{NAME_MAX}</span>
            </div>
            <input
              value={name}
              onChange={e => setName(sanitize(e.target.value, NAME_MAX))}
              placeholder="MyNFT"
              required
              className={inp}
            />
            <p className="text-xs text-gray-600 mt-1">Letters and numbers only, max {NAME_MAX} characters. Spaces and symbols are removed automatically.</p>
          </div>

          <div>
            <label className="block text-xs text-gray-400 mb-1">Description <span className="text-red-400">*</span></label>
            <textarea
              value={description}
              onChange={e => setDescription(mode === 'easy' ? e.target.value : sanitize(e.target.value, DESC_MAX))}
              placeholder={mode === 'easy' ? 'Describe your NFT…' : 'DescribeYourNFT'}
              required
              rows={3}
              className="w-full rounded-lg bg-gray-800 border border-gray-700 text-gray-100 placeholder-gray-600 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mint-600 resize-none"
            />
            {mode === 'easy'
              ? <p className="text-xs text-gray-600 mt-1">Free text. The full description is stored on IPFS; on-chain only letters &amp; numbers are kept (chain limit).</p>
              : <p className="text-xs text-gray-600 mt-1">Letters and numbers only, max {DESC_MAX} chars (chain constraint). Spaces/symbols removed automatically.</p>
            }
          </div>

          <div>
            <label className="block text-xs text-gray-400 mb-1">Ticker <span className="text-red-400">*</span></label>
            <input
              value={ticker}
              onChange={e => setTicker(e.target.value.toUpperCase())}
              maxLength={5}
              placeholder="MYNFT"
              required
              className={inp}
            />
            <p className="text-xs text-gray-500 mt-1">Short identifier, up to 5 characters</p>
          </div>

          {/* Media file — always shown, but label differs by mode */}
          <div>
            <label className="block text-xs text-gray-400 mb-1">
              Media file <span className="text-red-400">*</span>
              {mode === 'easy' && ipfsEnabled && (
                <span className="text-gray-500 font-normal ml-1">(hash computed and uploaded to IPFS automatically)</span>
              )}
              {mode === 'expert' && (
                <span className="text-gray-500 font-normal ml-1">(SHA-256 is computed and optionally uploaded to IPFS)</span>
              )}
            </label>
            <label className={`flex flex-col items-center justify-center rounded-lg border border-dashed border-gray-700 p-5 text-center cursor-pointer hover:border-gray-500 hover:bg-gray-800/40 transition-colors ${mediaUploading ? 'opacity-60 pointer-events-none' : ''}`}>
              {mediaHash ? (
                <div className="space-y-1">
                  <p className="text-xs text-green-400 font-medium">File processed</p>
                  {mode === 'expert' && (
                    <p className="text-xs text-gray-500 font-mono">SHA-256: {mediaHash.slice(0, 16)}…{mediaHash.slice(-8)}</p>
                  )}
                  {mediaUri && <p className="text-xs text-mint-400">Uploaded to IPFS</p>}
                  <p className="text-xs text-gray-600 mt-1">{mediaFile?.name} — Click to replace</p>
                </div>
              ) : (
                <div className="space-y-1">
                  <p className="text-sm text-gray-400">{mediaUploading ? 'Processing…' : 'Click to select media file'}</p>
                  <p className="text-xs text-gray-600">
                    {ipfsEnabled
                      ? 'Hash computed + uploaded to IPFS automatically'
                      : 'Hash computed locally — enter IPFS URL manually below if needed'}
                  </p>
                </div>
              )}
              <input
                type="file"
                className="hidden"
                disabled={mediaUploading}
                onChange={e => e.target.files?.[0] && handleMediaFile(e.target.files[0])}
              />
            </label>
          </div>

          {/* Expert-only fields */}
          {mode === 'expert' && (
            <>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Media hash (SHA-256 hex) <span className="text-red-400">*</span></label>
                <input
                  value={mediaHash}
                  onChange={e => setMediaHash(e.target.value)}
                  placeholder="Auto-filled when you select a file above"
                  required
                  className={inp}
                />
              </div>

              <div>
                <label className="block text-xs text-gray-400 mb-1">Media URI <span className="text-gray-500">(optional)</span></label>
                <input
                  value={mediaUri}
                  onChange={e => setMediaUri(e.target.value)}
                  placeholder="ipfs://… (auto-filled on upload)"
                  className={inp}
                />
              </div>

              <div>
                <label className="block text-xs text-gray-400 mb-1">Icon URI <span className="text-gray-500">(optional)</span></label>
                <div className="flex gap-2">
                  <input
                    value={iconUri}
                    onChange={e => setIconUri(e.target.value)}
                    placeholder="ipfs://…"
                    className={`${inp} flex-1`}
                  />
                  {ipfsEnabled && (
                    <label className={`shrink-0 rounded-lg border border-gray-700 px-3 py-2 text-xs text-gray-300 cursor-pointer hover:bg-gray-800 transition-colors ${iconUploading ? 'opacity-50 pointer-events-none' : ''}`}>
                      {iconUploading ? 'Uploading…' : 'Upload'}
                      <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        disabled={iconUploading}
                        onChange={e => e.target.files?.[0] && handleIconFile(e.target.files[0])}
                      />
                    </label>
                  )}
                </div>
              </div>

              <div>
                <label className="block text-xs text-gray-400 mb-1">Additional metadata URI <span className="text-gray-500">(optional)</span></label>
                <input
                  value={additionalMetaUri}
                  onChange={e => setAdditionalMetaUri(e.target.value)}
                  placeholder="ipfs://…"
                  className={inp}
                />
              </div>
            </>
          )}

          {/* Easy mode: icon upload */}
          {mode === 'easy' && ipfsEnabled && (
            <div>
              <label className="block text-xs text-gray-400 mb-1">Icon image <span className="text-gray-500">(optional)</span></label>
              <label className={`flex items-center gap-3 rounded-lg border border-dashed border-gray-700 px-4 py-3 cursor-pointer hover:border-gray-500 hover:bg-gray-800/40 transition-colors ${iconUploading ? 'opacity-60 pointer-events-none' : ''}`}>
                {iconUri ? (
                  <span className="text-xs text-mint-400">Uploaded — {iconFile?.name ?? 'icon'}</span>
                ) : iconUploading ? (
                  <span className="text-sm text-gray-400">Uploading…</span>
                ) : (
                  <span className="text-sm text-gray-400">Click to select icon image…</span>
                )}
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  disabled={iconUploading}
                  onChange={e => e.target.files?.[0] && handleIconFile(e.target.files[0])}
                />
              </label>
              <p className="text-xs text-gray-500 mt-1">Will be uploaded to IPFS automatically.</p>
            </div>
          )}

          {mode === 'easy' && !ipfsEnabled && (
            <div className="rounded-lg border border-amber-800 bg-amber-900/20 px-4 py-3 text-amber-300 text-xs">
              Set <code className="font-mono">IPFS_PROVIDER</code> in .env to enable automatic IPFS upload of media and icon.
            </div>
          )}

          <div>
            <label className="block text-xs text-gray-400 mb-1">Destination address <span className="text-red-400">*</span></label>
            <input
              value={destAddress}
              onChange={e => setDestAddress(e.target.value)}
              placeholder="mtc1…"
              required
              className={inp}
            />
            <p className="text-xs text-gray-500 mt-1">Your address — NFT will be sent here.</p>
          </div>

          {error && (
            <div className="rounded-lg border border-red-700 bg-red-900/30 p-3 text-red-300 text-sm">{error}</div>
          )}
        </div>

        <div className="px-6 pt-3 pb-1 text-xs text-amber-400/80 bg-gray-900 sticky bottom-0 border-t border-gray-800">
          Issuance burns <span className="font-semibold">5 ML</span> from your wallet (Mintlayer network fee, section 7.2).
        </div>
        <div className="flex gap-3 px-6 py-4 shrink-0 sticky bottom-0 bg-gray-900">
          <button type="button" onClick={onClose} className={cancelBtn}>Cancel</button>
          <button type="submit" disabled={submitting || !mediaHash} className={submitBtn}>
            {submitting ? 'Minting…' : 'Mint NFT'}
          </button>
        </div>
      </form>
    </Overlay>
  );
}

// ── Shared helpers ─────────────────────────────────────────────────────────────

function ModeToggle({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  return (
    <div className="flex rounded-lg border border-gray-700 overflow-hidden text-xs font-medium">
      <button
        type="button"
        onClick={() => onChange('easy')}
        className={`px-3 py-1 transition-colors ${mode === 'easy' ? 'bg-mint-700 text-white' : 'text-gray-400 hover:text-gray-200'}`}
      >
        Easy
      </button>
      <button
        type="button"
        onClick={() => onChange('expert')}
        className={`px-3 py-1 transition-colors ${mode === 'expert' ? 'bg-mint-700 text-white' : 'text-gray-400 hover:text-gray-200'}`}
      >
        Expert
      </button>
    </div>
  );
}

function Overlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div className="w-full max-w-lg rounded-xl bg-gray-900 border border-gray-800 shadow-2xl flex flex-col max-h-[90vh]">
        {children}
      </div>
    </div>
  );
}

const inp = 'w-full rounded-lg bg-gray-800 border border-gray-700 text-gray-100 placeholder-gray-600 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-mint-600';
const cancelBtn = 'flex-1 rounded-lg border border-gray-700 px-4 py-2 text-sm text-gray-300 hover:bg-gray-800 transition-colors';
const submitBtn = 'flex-1 rounded-lg bg-mint-700 hover:bg-mint-600 px-4 py-2 text-sm font-semibold text-white transition-colors disabled:opacity-50';
