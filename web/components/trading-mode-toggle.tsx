/**
 * web/components/trading-mode-toggle.tsx
 *
 * Per-user Paper / Live toggle. Renders a segmented control and calls the
 * setActiveTradingModeAction Server Action. Hard rules enforced server-side:
 *   - Live requires liveTradingAcknowledged=true
 *   - Live requires a connected live broker_connection
 * The button itself stays clickable; the server returns a clear error if the
 * preconditions aren't met, which we surface inline.
 */

'use client';

import { useActionState } from 'react';
import type { ResolvedBroker } from '@/lib/brokerResolver';
import { setActiveTradingModeAction, type ActionResult } from '@/app/dashboard/actions';

type ToggleMode = {
  label: string;
  broker: 'oanda' | 'alpaca';
  environment: 'practice' | 'paper' | 'live';
};

const MODES: ToggleMode[] = [
  { label: 'OANDA Practice', broker: 'oanda', environment: 'practice' },
  { label: 'OANDA Live',     broker: 'oanda', environment: 'live' },
  // Alpaca rows are scaffolded but not yet exposed — uncomment when Alpaca
  // creds are connectable from the form.
  // { label: 'Alpaca Paper', broker: 'alpaca', environment: 'paper' },
  // { label: 'Alpaca Live',  broker: 'alpaca', environment: 'live' },
];

async function actionWrapper(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  return setActiveTradingModeAction(formData);
}

export function TradingModeToggle({
  resolved,
}: {
  resolved: ResolvedBroker;
}) {
  const [state, formAction, pending] = useActionState(actionWrapper, null);
  const isLive = resolved.isLiveTrading;

  return (
    <section
      style={{
        background: 'var(--panel)',
        border: isLive ? '1px solid var(--bad)' : '1px solid var(--border)',
        borderRadius: 10,
        padding: 24,
        boxShadow: isLive ? '0 0 0 2px rgba(255,77,77,0.15) inset' : undefined,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 16 }}>Trading mode</h3>
          <p style={{ color: 'var(--muted)', marginTop: 8, fontSize: 13, maxWidth: 480 }}>
            Choose whether the bot runs against your practice or live broker account. The
            selection applies to scans, trade execution, and active-trade reassessment.
          </p>
        </div>
        <div
          style={{
            padding: '6px 14px',
            borderRadius: 6,
            fontSize: 13,
            fontWeight: 700,
            background: isLive ? '#320d0d' : '#0d3320',
            color: isLive ? 'var(--bad)' : 'var(--good)',
            border: `1px solid ${isLive ? '#5c1a1a' : '#1a5c38'}`,
            whiteSpace: 'nowrap',
          }}
        >
          Active Trading Mode: {resolved.isLiveTrading ? 'Live' : resolved.activeEnvironment === 'practice' ? 'Practice' : 'Paper'}
        </div>
      </div>

      <div
        style={{
          marginTop: 16,
          display: 'flex',
          gap: 8,
          padding: 4,
          background: 'var(--bg)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          width: 'fit-content',
        }}
      >
        {MODES.map((m) => {
          const isActive =
            resolved.activeBroker === m.broker && resolved.activeEnvironment === m.environment;
          return (
            <form key={`${m.broker}-${m.environment}`} action={formAction} style={{ margin: 0 }}>
              <input type="hidden" name="broker" value={m.broker} />
              <input type="hidden" name="environment" value={m.environment} />
              <button
                type="submit"
                disabled={pending}
                style={{
                  padding: '8px 18px',
                  border: 'none',
                  borderRadius: 6,
                  background: isActive
                    ? (m.environment === 'live' ? 'var(--bad)' : 'var(--border)')
                    : 'transparent',
                  color: isActive
                    ? (m.environment === 'live' ? '#fff' : 'var(--text)')
                    : 'var(--muted)',
                  fontFamily: 'inherit',
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: pending ? 'wait' : 'pointer',
                }}
              >
                {m.label}
              </button>
            </form>
          );
        })}
      </div>

      <div style={{ marginTop: 12, fontSize: 12, color: 'var(--muted)', maxWidth: 600, lineHeight: 1.5 }}>
        {resolved.reason}
      </div>

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
      {state && state.ok && (
        <div
          style={{
            marginTop: 12,
            padding: '10px 14px',
            background: '#0d3320',
            border: '1px solid #1a5c38',
            color: 'var(--good)',
            borderRadius: 6,
            fontSize: 13,
          }}
        >
          Trading mode updated.
        </div>
      )}
    </section>
  );
}
