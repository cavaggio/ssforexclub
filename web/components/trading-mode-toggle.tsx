/**
 * Per-user execution-account selector.
 * OANDA/Alpaca keep their existing practice/live semantics; FTMO prop modes
 * are selectable only after the server action confirms a live MT5 EA heartbeat.
 */

'use client';

import { useActionState } from 'react';
import type { ClientSafeBrokerStatus } from '@/lib/brokerResolver';
import { setActiveTradingModeAction, type ActionResult } from '@/app/dashboard/actions';

type ToggleMode = {
  label: string;
  broker: 'oanda' | 'alpaca' | 'ftmo';
  environment: 'practice' | 'paper' | 'live' | 'challenge' | 'verification' | 'funded';
  riskMode?: boolean;
};

const MODES: ToggleMode[] = [
  { label: 'OANDA Practice', broker: 'oanda', environment: 'practice' },
  { label: 'OANDA Live', broker: 'oanda', environment: 'live', riskMode: true },
  { label: 'FTMO Challenge', broker: 'ftmo', environment: 'challenge', riskMode: true },
  { label: 'FTMO Verification', broker: 'ftmo', environment: 'verification', riskMode: true },
  { label: 'FTMO Funded', broker: 'ftmo', environment: 'funded', riskMode: true },
];

async function actionWrapper(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  return setActiveTradingModeAction(formData);
}

function environmentLabel(value: string): string {
  if (value === 'challenge') return 'Challenge';
  if (value === 'verification') return 'Verification';
  if (value === 'funded') return 'Funded';
  if (value === 'practice') return 'Practice';
  if (value === 'paper') return 'Paper';
  if (value === 'live') return 'Live';
  return value;
}

export function TradingModeToggle({ resolved }: { resolved: ClientSafeBrokerStatus }) {
  const [state, formAction, pending] = useActionState(actionWrapper, null);
  const activeIsRiskMode = resolved.isLiveTrading || resolved.activeBroker === 'ftmo';

  return (
    <section
      style={{
        background: 'var(--panel)',
        border: activeIsRiskMode ? '1px solid var(--warn)' : '1px solid var(--border)',
        borderRadius: 10,
        padding: 24,
        boxShadow: activeIsRiskMode ? '0 0 0 2px rgba(255,178,36,0.10) inset' : undefined,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 16 }}>Trading mode</h3>
          <p style={{ color: 'var(--muted)', marginTop: 8, fontSize: 13, maxWidth: 620, lineHeight: 1.55 }}>
            Choose the account that receives autonomous execution. FTMO modes require a connected
            MT5 Expert Advisor and never fall back to OANDA execution when selected.
          </p>
        </div>
        <div
          style={{
            padding: '6px 14px',
            borderRadius: 6,
            fontSize: 13,
            fontWeight: 700,
            background: activeIsRiskMode ? '#33270d' : '#0d3320',
            color: activeIsRiskMode ? 'var(--warn)' : 'var(--good)',
            border: `1px solid ${activeIsRiskMode ? '#5c481a' : '#1a5c38'}`,
            whiteSpace: 'nowrap',
          }}
        >
          Active: {resolved.activeBroker ? resolved.activeBroker.toUpperCase() : '—'} · {environmentLabel(resolved.activeEnvironment)}
        </div>
      </div>

      <div
        style={{
          marginTop: 16,
          display: 'flex',
          flexWrap: 'wrap',
          gap: 8,
          padding: 4,
          background: 'var(--bg)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          width: 'fit-content',
        }}
      >
        {MODES.map((m) => {
          const isActive = resolved.activeBroker === m.broker && resolved.activeEnvironment === m.environment;
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
                  background: isActive ? (m.riskMode ? 'var(--warn)' : 'var(--border)') : 'transparent',
                  color: isActive ? (m.riskMode ? '#1b1400' : 'var(--text)') : 'var(--muted)',
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

      <div style={{ marginTop: 12, fontSize: 12, color: 'var(--muted)', maxWidth: 700, lineHeight: 1.5 }}>
        {resolved.reason}
      </div>

      {state && !state.ok && (
        <div style={{ marginTop: 12, padding: '10px 14px', background: '#320d0d', border: '1px solid #5c1a1a', color: 'var(--bad)', borderRadius: 6, fontSize: 13 }}>
          {state.error}
        </div>
      )}
      {state && state.ok && (
        <div style={{ marginTop: 12, padding: '10px 14px', background: '#0d3320', border: '1px solid #1a5c38', color: 'var(--good)', borderRadius: 6, fontSize: 13 }}>
          Trading mode updated.
        </div>
      )}
    </section>
  );
}
