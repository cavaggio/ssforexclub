'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

export function RemoveBrokerConnectionButton({
  connectionId,
  accountLabel,
}: {
  connectionId: string;
  accountLabel: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function removeConnection() {
    const confirmed = window.confirm(
      `Remove ${accountLabel}? This permanently deletes the saved credentials. You can add the account again afterward.`,
    );
    if (!confirmed) return;

    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/broker-connections/${encodeURIComponent(connectionId)}`, {
          method: 'DELETE',
        });
        const result = (await res.json().catch(() => ({ ok: false, error: 'Unexpected response' }))) as {
          ok: boolean;
          error?: string;
        };
        if (!res.ok || !result.ok) {
          setError(result.error || 'Could not remove broker connection');
          return;
        }
        router.refresh();
      } catch {
        setError('Could not reach the server');
      }
    });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
      <button
        type="button"
        onClick={removeConnection}
        disabled={pending}
        style={{
          padding: '6px 12px',
          background: 'transparent',
          color: 'var(--bad)',
          border: '1px solid #5c1a1a',
          borderRadius: 6,
          fontFamily: 'inherit',
          fontWeight: 700,
          fontSize: 12,
          cursor: pending ? 'wait' : 'pointer',
          opacity: pending ? 0.65 : 1,
        }}
      >
        {pending ? 'Removing…' : 'Remove'}
      </button>
      {error && <span style={{ color: 'var(--bad)', fontSize: 11 }}>{error}</span>}
    </div>
  );
}
