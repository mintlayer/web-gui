import { useState } from 'react';

export function CopyButton({ value, title = 'Copy' }: { value: string; title?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={() => {
        navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }).catch((err: unknown) => {
          // Clipboard can be denied (permissions/insecure context) — don't
          // leave an unhandled rejection; the icon simply stays idle.
          console.warn('clipboard write failed', err);
        });
      }}
      className={`ml-1.5 inline-flex items-center align-middle transition-colors
        ${copied ? 'text-mint-400' : 'text-gray-600 hover:text-mint-400'}`}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="9" y="9" width="13" height="13" rx="2" />
        <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
      </svg>
    </button>
  );
}
