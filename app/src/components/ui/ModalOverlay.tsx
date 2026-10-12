"use client"

import { useEffect, useRef, type ReactNode } from 'react';

interface ModalOverlayProps {
  onClose: () => void;
  /** Accessible name for the dialog (required for aria). */
  label: string;
  maxWidth?: string;
  maxHeight?: string;
  /** When false, Escape/backdrop-click no longer dismiss the dialog — use
   *  while a submit is in flight so a stray keypress can't abandon it. */
  dismissible?: boolean;
  children: ReactNode;
}

const FOCUSABLE = 'input, select, textarea, button, [href], [tabindex]:not([tabindex="-1"])';

/**
 * Fixed full-screen backdrop with a centered modal card; closes on backdrop
 * click and Escape. Focus is moved into the dialog on open, Tab is trapped
 * inside while open, and focus is restored to the previously focused element
 * on close. Toasts (z-[60]) always paint above this overlay (z-50).
 */
export function ModalOverlay({ onClose, label, maxWidth = 'max-w-lg', maxHeight = 'max-h-[90vh]', dismissible = true, children }: ModalOverlayProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  // Keep onClose in a ref so parent re-renders (inline closures) don't tear
  // down and re-run the setup effect — that used to steal focus back to the
  // first field mid-typing.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const dismissibleRef = useRef(dismissible);
  dismissibleRef.current = dismissible;

  useEffect(() => {
    restoreRef.current = document.activeElement as HTMLElement | null;
    // Focus the first focusable element inside the dialog.
    const focusable = cardRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    (focusable ?? cardRef.current)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dismissibleRef.current) {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key === 'Tab') {
        // Trap Tab inside the dialog: cycle within the card's focusables.
        const items = Array.from(
          cardRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
        ).filter(el => !el.hasAttribute('disabled'));
        if (items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement;
        if (e.shiftKey && (active === first || !cardRef.current?.contains(active))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (active === last || !cardRef.current?.contains(active))) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      restoreRef.current?.focus?.();
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs"
      onClick={e => dismissibleRef.current && e.target === e.currentTarget && onCloseRef.current()}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className={`w-full ${maxWidth} rounded-xl bg-gray-900 border border-gray-800 shadow-2xl flex flex-col outline-none ${maxHeight}`}
      >
        {children}
      </div>
    </div>
  );
}
