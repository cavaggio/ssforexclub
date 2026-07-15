'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { deleteBrokerConnectionAction } from '@/app/dashboard/actions';

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
    const formData = new FormData();
    formData.set('connectionId', connectionId);

    startTransition(async () => {
      const result = await deleteBrokerConnectionAction(formData);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
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
