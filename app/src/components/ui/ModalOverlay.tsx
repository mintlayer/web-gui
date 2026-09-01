"use client"

import type { ReactNode } from 'react';

interface ModalOverlayProps {
  onClose: () => void;
  maxWidth?: string;
  maxHeight?: string;
  children: ReactNode;
}

/** Fixed full-screen backdrop with a centered modal card; closes on backdrop click. */
export function ModalOverlay({ onClose, maxWidth = 'max-w-lg', maxHeight = 'max-h-[90vh]', children }: ModalOverlayProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div className={`w-full ${maxWidth} rounded-xl bg-gray-900 border border-gray-800 shadow-2xl flex flex-col ${maxHeight}`}>
        {children}
      </div>
    </div>
  );
}
