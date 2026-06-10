/**
 * web/components/risk-management-panel.tsx
 *
 * Read-only Risk Management panel. Surfaces the central risk-manager state for
 * the user's active account: balance, per-trade risk, daily drawdown budget,
 * trading-lock status, and the auto-execution confidence threshold.
 */

'use client';

import { useCallback, useEffect, useState } from 'react';

type RiskStatus = {
  accountBalance: number | null;
  riskPerTradePercent: number;
  riskAmountUSD: number;
  dailyStartingBalance: number;
  dailyRealizedPnL: number;
  dailyLossLimitPercent: number;
  dailyLossLimitUSD: number;
  remainingLossBudgetUSD: number;
  tradingLocked: boolean;
  autoExecutionConfidenceThreshold: number;
};

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; risk: RiskStatus };

const usd = (n: number | null | undefined) =>
  n == null ? '—' : `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function RiskManagementPanel() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/risk/status', { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok || !json?.ok || !json.risk) {
        setState({ kind: 'error', message: json?.error || `HTTP ${res.status}` });
        return;
      }
      setState({ kind: 'ready', risk: json.risk as RiskStatus });
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <section style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 12, padding: 16, marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <div style={{ fontWeight: 800, fontSize: 14 }}>Risk Management</div>
        <button onClick={() => void load()} style={btn}>Refresh</button>
      </div>

      {state.kind === 'loading' && <span style={{ color: 'var(--muted)', fontSize: 13 }}>Loading risk status…</span>}
      {state.kind === 'error' && <span style={{ color: 'var(--bad)', fontSize: 13 }}>Risk status: {state.message}</span>}

      {state.kind === 'ready' && (() => {
        const r = state.risk;
        return (
          <>
            <div style={grid}>
              <KV label="Account Balance" value={usd(r.accountBalance)} />
              <KV label="Risk Per Trade" value={`${r.riskPerTradePercent}%`} />
              <KV label="Risk Amount" value={usd(r.riskAmountUSD)} />
              <KV label="Daily Starting Balance" value={usd(r.dailyStartingBalance)} />
              <KV
                label="Daily Realized P&L"
                value={usd(r.dailyRealizedPnL)}
                color={r.dailyRealizedPnL < 0 ? 'var(--bad)' : r.dailyRealizedPnL > 0 ? 'var(--good)' : undefined}
              />
              <KV label={`Daily Loss Limit (${r.dailyLossLimitPercent}%)`} value={usd(r.dailyLossLimitUSD)} />
              <KV
                label="Remaining Loss Budget"
                value={usd(r.remainingLossBudgetUSD)}
                color={r.remainingLossBudgetUSD <= 0 ? 'var(--bad)' : 'var(--good)'}
              />
              <KV label="Execution Threshold" value={`${r.autoExecutionConfidenceThreshold}%`} />
            </div>
            <div style={{ marginTop: 12, fontSize: 13 }}>
              Trading Locked:{' '}
              <strong style={{ color: r.tradingLocked ? 'var(--bad)' : 'var(--good)' }}>
                {r.tradingLocked ? 'Yes — new entries blocked (open trades still managed)' : 'No'}
              </strong>
            </div>
          </>
        );
      })()}
    </section>
  );
}

function KV({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</span>
      <span style={{ fontSize: 14, fontWeight: 700, color: color || 'var(--text)', fontFamily: 'var(--mono, monospace)' }}>{value}</span>
    </div>
  );
}

const grid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 };
const btn: React.CSSProperties = {
  background: 'var(--border)', color: 'var(--text)', border: '1px solid transparent', borderRadius: 6,
  padding: '6px 14px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
};
