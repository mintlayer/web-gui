import { useState } from 'react';
import IssueTokenModal from './IssueTokenModal';

interface Props {
  ipfsEnabled: boolean;
}

export default function IssueTokenButton({ ipfsEnabled }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="rounded-lg bg-mint-700 hover:bg-mint-600 px-3 py-1.5 text-sm font-semibold text-white transition-colors"
      >
        Mint Token
      </button>

      {open && (
        <IssueTokenModal
          ipfsEnabled={ipfsEnabled}
          onClose={() => setOpen(false)}
          onIssued={() => setTimeout(() => window.location.reload(), 3000)}
        />
      )}
    </>
  );
}
