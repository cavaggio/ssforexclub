/**
 * web/components/live-ack-card.tsx
 *
 * One-time live-trading acknowledgement (Part 5). The card is rendered only
 * when liveTradingAcknowledged === false. After the user accepts, the flag is
 * persisted and the card disappears on the next render. Switching back to
 * practice/paper does NOT reset the flag.
 */

'use client';

import { useActionState } from 'react';
import { acknowledgeLiveTradingAction, type ActionResult } from '@/app/dashboard/actions';

async function actionWrapper(_prev: ActionResult | null): Promise<ActionResult> {
  return acknowledgeLiveTradingAction();
}

export function LiveAckCard() {
  const [state, formAction, pending] = useActionState(actionWrapper, null);
  return (
    <section
      style={{
        background: '#1f1100',
        border: '1px solid #5c4400',
        borderRadius: 10,
        padding: 24,
      }}
    >
      <h3 style={{ margin: 0, fontSize: 16, color: 'var(--warn)' }}>
        Enable live trading
      </h3>
      <p style={{ color: 'var(--text)', marginTop: 8, fontSize: 13, lineHeight: 1.55 }}>
        Live trading places real orders with real funds in your linked broker account.
        You alone are responsible for any losses. Practice/paper mode remains available
        at all times — you can switch back at any moment.
      </p>
      <label
        style={{
          marginTop: 16,
          display: 'flex',
          gap: 10,
          alignItems: 'flex-start',
          fontSize: 13,
          color: 'var(--text)',
        }}
      >
        <input type="checkbox" id="live-ack-confirm" />
        <span>
          I understand live trading uses real funds and I am responsible for all trading risk.
        </span>
      </label>
      <form action={formAction} style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end' }}>
        <button
          type="submit"
          disabled={pending}
          onClick={(e) => {
            // Cheap client-side gate — the Server Action does its own validation.
            const cb = document.getElementById('live-ack-confirm') as HTMLInputElement | null;
            if (!cb?.checked) {
              e.preventDefault();
              alert('Please tick the checkbox to confirm.');
            }
          }}
          style={{
            padding: '10px 24px',
            background: 'var(--warn)',
            color: '#1a1100',
            border: 'none',
            borderRadius: 6,
            fontFamily: 'inherit',
            fontWeight: 700,
            fontSize: 13,
            cursor: pending ? 'wait' : 'pointer',
          }}
        >
          {pending ? 'Saving…' : 'I acknowledge — enable live mode'}
        </button>
      </form>
      {state && !state.ok && (
        <div
          style={{
            marginTop: 12,
            padding: '10px 14px',
            background: '#320d0d',
            border: '1px solid #5c1a1a',
            color: 'var(--bad)',
            borderRadius: 6,
            fontSize: 13,
          }}
        >
          {state.error}
        </div>
      )}
    </section>
  );
}
