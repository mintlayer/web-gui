/**
 * "Did you mean…?" address typo-correction chip, shared by the Bitcoin and
 * Bridge send flows (bech32 checksum recovery). Never auto-replaces input —
 * the user must accept the suggestion explicitly.
 */

interface AddressSuggestionProps {
  corrected: string;
  fixedChars: number;
  onAccept: () => void;
  onDismiss?: () => void;
}

export default function AddressSuggestion({
  corrected,
  fixedChars,
  onAccept,
  onDismiss,
}: AddressSuggestionProps) {
  return (
    <div
      role="status"
      className="rounded-lg border border-amber-800 bg-amber-900/20 px-3 py-2 text-xs text-amber-300"
    >
      Did you mean <code className="font-mono text-mint-300 break-all">{corrected}</code>?
      <span className="text-amber-400/80">
        {' '}
        (fixed {fixedChars} character{fixedChars === 1 ? '' : 's'})
      </span>{' '}
      <button
        type="button"
        onClick={onAccept}
        className="ml-1 underline font-semibold hover:text-amber-200"
      >
        Use suggested address
      </button>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss suggestion"
          className="ml-2 text-amber-400/70 hover:text-amber-200"
        >
          ✕
        </button>
      )}
    </div>
  );
}
