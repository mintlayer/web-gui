import type { RefObject } from 'react';

/**
 * Shared 6-digit TOTP input used by token-authority flows. Strips non-digits
 * on paste ("123 456" → "123456") so pasted codes with separators work.
 */
export function TotpField({
  value,
  onChange,
  inputRef,
  disabled = false,
  className = '',
}: {
  value: string;
  onChange: (v: string) => void;
  inputRef?: RefObject<HTMLInputElement | null>;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div>
      <label className="block text-xs text-gray-400 mb-1">2FA code</label>
      <input
        ref={inputRef}
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        value={value}
        onChange={e => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
        placeholder="000000"
        disabled={disabled}
        aria-invalid={false}
        className={
          className ||
          'w-full rounded-lg bg-gray-800 border border-gray-700 text-gray-100 placeholder-gray-600 px-3 py-2 text-sm font-mono tracking-[0.3em] focus:outline-none focus:ring-2 focus:ring-mint-600 disabled:opacity-50'
        }
      />
    </div>
  );
}
