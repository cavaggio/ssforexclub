/**
 * web/components/validate-connections-button.tsx
 *
 * Re-checks every saved broker connection's credentials against its own broker
 * and persists validation_status, then the page revalidates so the rows update.
 * No credentials touch the browser — the action runs entirely server-side.
 */

'use client';

import { useState, useTransition } from 'react';
import { validateConnectionsAction, type ValidateActionResult } from '@/app/dashboard/validate-actions';

export function ValidateConnectionsButton() {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ValidateActionResult | null>(null);

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
      <button
        onClick={() => startTransition(async () => setResult(await validateConnectionsAction()))}
        disabled={pending}
        style={{
          padding: '6px 14px', background: 'transparent', color: 'var(--text)',
          border: '1px solid var(--border)', borderRadius: 6, fontFamily: 'inherit',
          fontWeight: 700, fontSize: 12, cursor: pending ? 'wait' : 'pointer',
        }}
      >
        {pending ? 'Checking…' : 'Re-check connections'}
      </button>
      {result && result.ok && (
        <span style={{ color: 'var(--muted)', fontSize: 12 }}>
          {result.validated} validated · {result.failed} failed
          {result.skipped ? ` · ${result.skipped} unreachable` : ''}
        </span>
      )}
      {result && !result.ok && (
        <span style={{ color: 'var(--bad)', fontSize: 12 }}>{result.error}</span>
      )}
    </span>
  );
}
