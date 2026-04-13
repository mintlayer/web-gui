import { useState, useRef, useCallback } from 'react';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SeedBackupStepProps {
  mnemonic: string;    // space-separated word string
  walletPath: string;  // for display in success panel and print header
}

type BackupPhase =
  | { phase: 'display' }
  | {
      phase: 'verify';
      indices: [number, number, number, number];
      inputs: [string, string, string, string];
      error: boolean;
      shaking: boolean;
    }
  | { phase: 'success' };

// ── Helpers ───────────────────────────────────────────────────────────────────

function pickVerificationIndices(wordCount: number): [number, number, number, number] {
  const pool = Array.from({ length: wordCount }, (_, i) => i);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, 4).sort((a, b) => a - b) as [number, number, number, number];
}

// ── Print CSS (injected once, hidden outside print) ───────────────────────────

const PRINT_STYLE = `
@media print {
  body > * { display: none !important; }
  #seed-print-area {
    display: block !important;
    position: fixed;
    inset: 0;
    padding: 2.5rem;
    background: white;
    color: black;
    font-family: serif;
  }
}
#seed-print-area { display: none; }
`;

// ── Sub-components ────────────────────────────────────────────────────────────

function WordGrid({ words }: { words: string[] }) {
  return (
    <div className="grid grid-cols-2 gap-x-8 gap-y-2 font-mono text-sm bg-gray-950 rounded-xl p-5">
      {words.map((word, i) => (
        <div key={i} className="flex items-baseline gap-2">
          <span className="text-xs text-gray-500 w-6 text-right shrink-0 select-none">{i + 1}.</span>
          <span className="text-gray-100 font-medium">{word}</span>
        </div>
      ))}
    </div>
  );
}

function PrintArea({ words, walletPath }: { words: string[]; walletPath: string }) {
  const date = new Date().toLocaleDateString();
  return (
    <div id="seed-print-area">
      <div style={{ marginBottom: '1rem' }}>
        <h1 style={{ fontSize: '1.4rem', fontWeight: 'bold', marginBottom: '0.25rem' }}>
          Mintlayer Wallet — Seed Phrase Backup
        </h1>
        <p style={{ fontSize: '0.8rem', color: '#555' }}>
          Wallet: {walletPath} &nbsp;|&nbsp; Generated: {date}
        </p>
      </div>
      <div
        style={{
          border: '2px solid #333',
          borderRadius: '6px',
          padding: '1rem 1.5rem',
          marginBottom: '1rem',
          background: '#fafafa',
        }}
      >
        <p style={{ fontSize: '0.75rem', color: '#c00', fontWeight: 'bold', marginBottom: '0.75rem' }}>
          ⚠ KEEP THIS PAPER SAFE. Never photograph, scan, or store these words digitally.
        </p>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '0.4rem 3rem',
          }}
        >
          {words.map((word, i) => (
            <div key={i} style={{ display: 'flex', gap: '0.5rem', fontFamily: 'monospace' }}>
              <span style={{ color: '#777', minWidth: '1.5rem', textAlign: 'right' }}>{i + 1}.</span>
              <span style={{ fontWeight: 'bold' }}>{word}</span>
            </div>
          ))}
        </div>
      </div>
      <p style={{ fontSize: '0.75rem', color: '#777' }}>mintlayer.org</p>
    </div>
  );
}

// ── Display phase ─────────────────────────────────────────────────────────────

function SeedDisplayPanel({
  words,
  walletPath,
  onConfirm,
}: {
  words: string[];
  walletPath: string;
  onConfirm: () => void;
}) {
  return (
    <div className="max-w-xl">
      <style dangerouslySetInnerHTML={{ __html: PRINT_STYLE }} />
      <PrintArea words={words} walletPath={walletPath} />

      <h2 className="text-xl font-bold text-gray-100 mb-2">Back up your seed phrase</h2>
      <p className="text-sm text-gray-400 mb-5">
        Your wallet was created. Write down the {words.length} words below{' '}
        <strong className="text-yellow-400">with pen and paper</strong>. Never photograph,
        screenshot, or store them digitally.
      </p>

      <div className="rounded-lg border border-yellow-700 bg-yellow-900/20 px-4 py-3 mb-5 text-yellow-300 text-xs flex gap-2 items-start">
        <span className="mt-0.5 shrink-0">⚠</span>
        <span>
          These words are the only way to recover your wallet if the file is lost.
          Anyone with access to them can steal your funds.
        </span>
      </div>

      <WordGrid words={words} />

      <div className="flex items-center gap-3 mt-5">
        <button
          type="button"
          onClick={() => window.print()}
          className="rounded-lg border border-gray-700 bg-gray-800 hover:bg-gray-700 px-4 py-2 text-sm text-gray-300 transition-colors"
        >
          Print backup sheet
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="rounded-lg bg-mint-700 hover:bg-mint-600 px-5 py-2 text-sm font-semibold text-white transition-colors"
        >
          I've written it down →
        </button>
      </div>
    </div>
  );
}

// ── Verify phase ──────────────────────────────────────────────────────────────

function SeedVerifyPanel({
  words,
  indices,
  inputs,
  error,
  shaking,
  onChange,
  onSubmit,
  onBack,
}: {
  words: string[];
  indices: [number, number, number, number];
  inputs: [string, string, string, string];
  error: boolean;
  shaking: boolean;
  onChange: (slot: number, val: string) => void;
  onSubmit: () => void;
  onBack: () => void;
}) {
  return (
    <div className="max-w-md">
      <h2 className="text-xl font-bold text-gray-100 mb-2">Verify your backup</h2>
      <p className="text-sm text-gray-400 mb-6">
        Enter the words at the positions below to confirm you've written them down correctly.
      </p>

      <div
        className={`space-y-4 transition-transform ${shaking ? 'animate-shake' : ''}`}
        style={shaking ? { animation: 'shake 0.5s ease' } : {}}
      >
        {indices.map((wordIdx, slot) => (
          <div key={slot}>
            <label className="block text-xs text-gray-400 mb-1">
              Word #{wordIdx + 1}
            </label>
            <input
              type="text"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              value={inputs[slot]}
              onChange={e => onChange(slot, e.target.value)}
              onKeyDown={e => e.key === 'Enter' && onSubmit()}
              className="w-full rounded-lg bg-gray-800 border border-gray-700 text-gray-100 placeholder-gray-600
                         px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-mint-600"
              placeholder={`word ${wordIdx + 1}`}
            />
          </div>
        ))}
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-red-700 bg-red-900/30 px-4 py-3 text-red-300 text-xs">
          One or more words didn't match. Check your backup and try again.
        </div>
      )}

      <div className="flex items-center gap-3 mt-6">
        <button
          type="button"
          onClick={onBack}
          className="rounded-lg border border-gray-700 bg-gray-800 hover:bg-gray-700 px-4 py-2 text-sm text-gray-300 transition-colors"
        >
          ← Back to seed phrase
        </button>
        <button
          type="button"
          onClick={onSubmit}
          className="rounded-lg bg-mint-700 hover:bg-mint-600 px-5 py-2 text-sm font-semibold text-white transition-colors"
        >
          Verify →
        </button>
      </div>

      <style>{`
        @keyframes shake {
          0%, 100% { transform: translateX(0); }
          15%       { transform: translateX(-6px); }
          30%       { transform: translateX(6px); }
          45%       { transform: translateX(-5px); }
          60%       { transform: translateX(5px); }
          75%       { transform: translateX(-3px); }
          90%       { transform: translateX(3px); }
        }
      `}</style>
    </div>
  );
}

// ── Success phase ─────────────────────────────────────────────────────────────

function SeedSuccessPanel({ walletPath }: { walletPath: string }) {
  return (
    <div className="max-w-md">
      <div className="rounded-xl border border-mint-700 bg-mint-900/30 p-6">
        <div className="flex items-center gap-3 mb-3">
          <span className="text-2xl">✓</span>
          <h2 className="text-lg font-bold text-mint-300">Backup verified!</h2>
        </div>
        <p className="text-sm text-gray-300 mb-1">
          Your wallet is ready. Wallet file:
        </p>
        <p className="text-xs font-mono text-gray-400 mb-4 break-all">{walletPath}</p>
        <p className="text-xs text-gray-500 mb-5">
          To view your seed phrase again, go to{' '}
          <strong className="text-gray-400">Management → Show Seed Phrase</strong>.
        </p>
        <a
          href="/"
          className="inline-block rounded-lg bg-mint-700 hover:bg-mint-600 px-5 py-2 text-sm font-semibold text-white transition-colors"
        >
          Go to dashboard →
        </a>
      </div>
    </div>
  );
}

// ── Root component ────────────────────────────────────────────────────────────

export default function SeedBackupStep({ mnemonic, walletPath }: SeedBackupStepProps) {
  const words = mnemonic.trim().split(/\s+/);
  const [step, setStep] = useState<BackupPhase>({ phase: 'display' });
  const shakeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const beginVerify = useCallback(() => {
    setStep({
      phase: 'verify',
      indices: pickVerificationIndices(words.length),
      inputs: ['', '', '', ''],
      error: false,
      shaking: false,
    });
  }, [words.length]);

  const handleVerify = useCallback(() => {
    if (step.phase !== 'verify') return;
    const allCorrect = step.indices.every(
      (idx, slot) => step.inputs[slot].trim().toLowerCase() === words[idx].toLowerCase(),
    );
    if (allCorrect) {
      setStep({ phase: 'success' });
    } else {
      if (shakeTimer.current) clearTimeout(shakeTimer.current);
      setStep({ ...step, shaking: true, error: true, inputs: ['', '', '', ''] });
      shakeTimer.current = setTimeout(() => {
        setStep(s => (s.phase === 'verify' ? { ...s, shaking: false } : s));
      }, 600);
    }
  }, [step, words]);

  const handleChange = useCallback(
    (slot: number, val: string) => {
      if (step.phase !== 'verify') return;
      const next = [...step.inputs] as [string, string, string, string];
      next[slot] = val;
      setStep({ ...step, inputs: next });
    },
    [step],
  );

  if (step.phase === 'display') {
    return (
      <SeedDisplayPanel
        words={words}
        walletPath={walletPath}
        onConfirm={beginVerify}
      />
    );
  }

  if (step.phase === 'verify') {
    return (
      <SeedVerifyPanel
        words={words}
        indices={step.indices}
        inputs={step.inputs}
        error={step.error}
        shaking={step.shaking}
        onChange={handleChange}
        onSubmit={handleVerify}
        onBack={() => setStep({ phase: 'display' })}
      />
    );
  }

  return <SeedSuccessPanel walletPath={walletPath} />;
}
