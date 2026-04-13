import { useState, useEffect } from 'react';
import { submitWithToast } from '@/lib/toastStore';
import { watchTx } from '@/lib/txWatcher';
import { CopyButton } from '@/components/CopyButton';

type SupplyType = 'Fixed' | 'Lockable' | 'Unlimited';
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

async function uploadFile(file: File): Promise<string> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch('/api/ipfs-upload', { method: 'POST', body: form });
  const data = await res.json() as { ok: boolean; url?: string; error?: { message: string } };
  if (!data.ok) throw new Error(data.error?.message ?? 'Upload failed');
  return data.url!;
}

export default function IssueTokenModal({ ipfsEnabled, onClose, onIssued }: Props) {
  const [mode, setMode] = useState<Mode>('easy');

  // Easy mode fields
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [logoFile, setLogoFile] = useState<File | null>(null);

  // Shared fields
  const [ticker, setTicker] = useState('');
  const [decimals, setDecimals] = useState(8);
  const [supplyType, setSupplyType] = useState<SupplyType>('Fixed');
  const [fixedAmount, setFixedAmount] = useState('');
  const [isFreezable, setIsFreezable] = useState(false);
  const [destAddress, setDestAddress] = useState('');

  // Expert mode fields
  const [metadataUri, setMetadataUri] = useState('');
  const [uploading, setUploading] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [issuedTokenId, setIssuedTokenId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Pre-fill authority address with first unused address on mount
  useEffect(() => {
    rpc<{ address: string; used: boolean }[]>('address_show', { account: 0, include_change_addresses: false })
      .then(addrs => {
        const first = addrs.find(a => !a.used) ?? addrs[addrs.length - 1];
        if (first) setDestAddress(first.address);
      })
      .catch(() => { /* leave blank, user types manually */ });
  }, []);

  async function handleExpertUpload(file: File) {
    setUploading(true);
    setError(null);
    try {
      const url = await uploadFile(file);
      setMetadataUri(url);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    const token_supply =
      supplyType === 'Fixed'
        ? { type: 'Fixed', content: { decimal: fixedAmount } }
        : { type: supplyType };

    try {
      let resolvedMetadataUri = metadataUri;

      if (mode === 'easy' && ipfsEnabled) {
        // 1. Upload logo if provided
        let logoUrl: string | undefined;
        if (logoFile) {
          logoUrl = await uploadFile(logoFile);
        }

        // 2. Build and upload metadata JSON
        const meta: Record<string, unknown> = { name, description, symbol: ticker, decimals };
        if (logoUrl) meta.image = logoUrl;
        const jsonBlob = new Blob([JSON.stringify(meta)], { type: 'application/json' });
        const jsonFile = new File([jsonBlob], 'metadata.json', { type: 'application/json' });
        resolvedMetadataUri = await uploadFile(jsonFile);
      }

      let newTokenId = '';
      await submitWithToast(async () => {
        const res = await rpc<{ token_id: string; tx_id: string }>('token_issue_new', {
          account: 0,
          destination_address: destAddress,
          metadata: {
            token_ticker: ticker,
            number_of_decimals: decimals,
            metadata_uri: resolvedMetadataUri ? toHexField(resolvedMetadataUri) : '',
            token_supply,
            is_freezable: isFreezable,
          },
          options: {},
        });
        newTokenId = res.token_id;
        return res.tx_id;
      }, watchTx);
      setIssuedTokenId(newTokenId);
      onIssued?.(newTokenId);

      // Persist to localStorage so "My Issued Tokens" can show it even at zero balance
      try {
        const stored = JSON.parse(localStorage.getItem('ml_issued_tokens') ?? '[]') as Array<{ tokenId: string; ticker: string; decimals: number; issuedAt: number }>;
        stored.unshift({ tokenId: newTokenId, ticker, decimals, issuedAt: Date.now() });
        localStorage.setItem('ml_issued_tokens', JSON.stringify(stored));
      } catch { /* ignore — non-critical */ }
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
          <h2 className="text-lg font-semibold text-gray-100 mb-2">Token Issued!</h2>
          <p className="text-sm text-gray-400 mb-4">Your new token ID:</p>
          <span className="inline-flex items-center gap-1 flex-wrap justify-center">
            <code className="block rounded bg-gray-800 px-3 py-2 text-xs font-mono text-mint-400 break-all">{issuedTokenId}</code>
            <CopyButton value={issuedTokenId} title="Copy token ID" />
          </span>
          <p className="text-xs text-gray-500 mt-3">Token will appear in your wallet once the transaction is confirmed.</p>
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
        <h2 className="text-base font-semibold text-gray-100">Issue Fungible Token</h2>
        <div className="flex items-center gap-3">
          <ModeToggle mode={mode} onChange={setMode} />
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-xl leading-none">✕</button>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="overflow-y-auto flex-1">
        <div className="px-6 py-4 space-y-4">

          {/* ── Easy mode extra fields ─────────────────────────────────────── */}
          {mode === 'easy' && (
            <>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Token name <span className="text-red-400">*</span></label>
                <input
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="My Token"
                  required
                  className={input}
                />
              </div>

              <div>
                <label className="block text-xs text-gray-400 mb-1">Description</label>
                <textarea
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  placeholder="Describe your token…"
                  rows={2}
                  className="w-full rounded-lg bg-gray-800 border border-gray-700 text-gray-100 placeholder-gray-600 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mint-600 resize-none"
                />
              </div>
            </>
          )}

          {/* ── Shared fields ──────────────────────────────────────────────── */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Ticker <span className="text-red-400">*</span></label>
              <input
                value={ticker}
                onChange={e => setTicker(e.target.value.toUpperCase())}
                maxLength={5}
                placeholder="MYTKN"
                required
                className={input}
              />
              <p className="text-xs text-gray-500 mt-1">Up to 5 characters</p>
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Decimals <span className="text-red-400">*</span></label>
              <input
                type="number"
                min={0}
                max={18}
                value={decimals}
                onChange={e => setDecimals(Number(e.target.value))}
                required
                className={input}
              />
            </div>
          </div>

          <div>
            <label className="block text-xs text-gray-400 mb-2">Total supply <span className="text-red-400">*</span></label>
            <div className="flex gap-4 mb-2">
              {(['Fixed', 'Lockable', 'Unlimited'] as const).map(t => (
                <label key={t} className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    name="supplyType"
                    value={t}
                    checked={supplyType === t}
                    onChange={() => setSupplyType(t)}
                    className="accent-mint-500"
                  />
                  <span className="text-sm text-gray-300">{t}</span>
                </label>
              ))}
            </div>
            {supplyType === 'Fixed' && (
              <input
                type="number"
                min="0"
                step="any"
                value={fixedAmount}
                onChange={e => setFixedAmount(e.target.value)}
                placeholder="Total supply"
                required
                className={input}
              />
            )}
            {supplyType === 'Lockable' && (
              <p className="text-xs text-gray-500">Mintable until the authority locks it.</p>
            )}
            {supplyType === 'Unlimited' && (
              <p className="text-xs text-gray-500">Can be minted forever without limit.</p>
            )}
          </div>

          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={isFreezable}
              onChange={e => setIsFreezable(e.target.checked)}
              className="rounded accent-mint-500"
            />
            <span className="text-sm text-gray-300">Allow token to be frozen</span>
          </label>

          {/* ── Easy: logo upload / Expert: metadata URI ───────────────────── */}
          {mode === 'easy' ? (
            ipfsEnabled ? (
              <div>
                <label className="block text-xs text-gray-400 mb-1">Logo image <span className="text-gray-500">(optional)</span></label>
                <label className="flex items-center gap-3 rounded-lg border border-dashed border-gray-700 px-4 py-3 cursor-pointer hover:border-gray-500 hover:bg-gray-800/40 transition-colors">
                  {logoFile ? (
                    <span className="text-sm text-green-400">{logoFile.name}</span>
                  ) : (
                    <span className="text-sm text-gray-400">Click to select logo image…</span>
                  )}
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={e => setLogoFile(e.target.files?.[0] ?? null)}
                  />
                </label>
                <p className="text-xs text-gray-500 mt-1">Will be uploaded to IPFS automatically.</p>
              </div>
            ) : (
              <div className="rounded-lg border border-amber-800 bg-amber-900/20 px-4 py-3 text-amber-300 text-xs">
                Set <code className="font-mono">IPFS_PROVIDER</code> in .env to enable automatic IPFS upload of logo and metadata.
              </div>
            )
          ) : (
            <div>
              <label className="block text-xs text-gray-400 mb-1">Metadata URI <span className="text-gray-500">(optional)</span></label>
              <div className="flex gap-2">
                <input
                  value={metadataUri}
                  onChange={e => setMetadataUri(e.target.value)}
                  placeholder="ipfs://… or https://…"
                  className={`${input} flex-1`}
                />
                {ipfsEnabled && (
                  <label className={`shrink-0 rounded-lg border border-gray-700 px-3 py-2 text-xs text-gray-300 cursor-pointer hover:bg-gray-800 transition-colors ${uploading ? 'opacity-50 pointer-events-none' : ''}`}>
                    {uploading ? 'Uploading…' : 'Upload'}
                    <input type="file" className="hidden" disabled={uploading} onChange={e => e.target.files?.[0] && handleExpertUpload(e.target.files[0])} />
                  </label>
                )}
              </div>
              {!ipfsEnabled && (
                <p className="text-xs text-gray-500 mt-1">Set IPFS_PROVIDER in .env to enable IPFS upload.</p>
              )}
            </div>
          )}

          <div>
            <label className="block text-xs text-gray-400 mb-1">Authority address <span className="text-red-400">*</span></label>
            <input
              value={destAddress}
              onChange={e => setDestAddress(e.target.value)}
              placeholder="mtc1…"
              required
              className={input}
            />
            <p className="text-xs text-gray-500 mt-1">Your address — will have authority to mint, freeze, and modify this token.</p>
          </div>

          {error && (
            <div className="rounded-lg border border-red-700 bg-red-900/30 p-3 text-red-300 text-sm">{error}</div>
          )}
        </div>

        <div className="px-6 pt-3 pb-1 text-xs text-amber-400/80 bg-gray-900 sticky bottom-0 border-t border-gray-800">
          Issuance burns <span className="font-semibold">100 ML</span> from your wallet (Mintlayer network fee, section 7.2).
        </div>
        <div className="flex gap-3 px-6 py-4 shrink-0 sticky bottom-0 bg-gray-900">
          <button type="button" onClick={onClose} className={cancelBtn}>Cancel</button>
          <button type="submit" disabled={submitting} className={submitBtn}>
            {submitting ? 'Issuing…' : 'Issue Token'}
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

const input = 'w-full rounded-lg bg-gray-800 border border-gray-700 text-gray-100 placeholder-gray-600 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-mint-600';
const cancelBtn = 'flex-1 rounded-lg border border-gray-700 px-4 py-2 text-sm text-gray-300 hover:bg-gray-800 transition-colors';
const submitBtn = 'flex-1 rounded-lg bg-mint-700 hover:bg-mint-600 px-4 py-2 text-sm font-semibold text-white transition-colors disabled:opacity-50';
