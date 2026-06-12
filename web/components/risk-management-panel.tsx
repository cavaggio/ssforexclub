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
  currentBalance: number | null;
  riskPerTradePercent: number;
  riskAmountUSD: number;
  dailyStartingBalance: number;
  dailyRealizedPnL: number;
  dailyProfitTargetPercent: number;
  dailyProfitTargetUSD: number;
  dailyLossLimitPercent: number;
  dailyLossLimitUSD: number;
  remainingLossBudgetUSD: number;
  openTradeRiskUSD: number;
  projectedDailyRiskUSD: number;
  tradingLocked: boolean;
  conservativeMode: boolean;
  capitalProtectionMode: boolean;
  autoExecutionConfidenceThreshold: number;
  currentAutoConfidenceThreshold: number;
  lastRejectedReason: string | null;
  lastAccountRiskAction: string | null;
  lastReassessmentAction: string | null;
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
              <KV label="Daily Starting Balance" value={usd(r.dailyStartingBalance)} />
              <KV label="Current Balance" value={usd(r.currentBalance ?? r.accountBalance)} />
              <KV
                label="Realized Daily P&L"
                value={usd(r.dailyRealizedPnL)}
                color={r.dailyRealizedPnL < 0 ? 'var(--bad)' : r.dailyRealizedPnL > 0 ? 'var(--good)' : undefined}
              />
              <KV
                label={`Daily Profit Target (+${r.dailyProfitTargetPercent}%)`}
                value={usd(r.dailyProfitTargetUSD)}
                color={r.dailyRealizedPnL >= r.dailyProfitTargetUSD && r.dailyProfitTargetUSD > 0 ? 'var(--good)' : undefined}
              />
              <KV label={`Daily Loss Limit (${r.dailyLossLimitPercent}%)`} value={usd(r.dailyLossLimitUSD)} />
              <KV
                label="Remaining Daily Loss Budget"
                value={usd(r.remainingLossBudgetUSD)}
                color={r.remainingLossBudgetUSD <= 0 ? 'var(--bad)' : 'var(--good)'}
              />
              <KV label="Open Trade Risk" value={usd(r.openTradeRiskUSD)} />
              <KV
                label="Projected Daily Risk"
                value={usd(r.projectedDailyRiskUSD)}
                color={r.projectedDailyRiskUSD > r.dailyLossLimitUSD ? 'var(--bad)' : undefined}
              />
              <KV label="Risk Per Trade" value={`${r.riskPerTradePercent}%`} />
              <KV label="Auto Confidence Threshold" value={`${r.currentAutoConfidenceThreshold}%`} />
            </div>
            <div style={{ marginTop: 12, fontSize: 13 }}>
              Trading Locked:{' '}
              <strong style={{ color: r.tradingLocked ? 'var(--bad)' : 'var(--good)' }}>
                {r.tradingLocked ? 'Yes — new entries blocked (open trades still managed)' : 'No'}
              </strong>
            </div>
            <div style={{ marginTop: 6, fontSize: 13 }}>
              Capital Protection Mode:{' '}
              <strong style={{ color: r.capitalProtectionMode ? 'var(--good)' : 'var(--muted)' }}>
                {r.capitalProtectionMode ? 'Yes — +2% target hit; only elite setups, protect gains' : 'No'}
              </strong>
            </div>
            <div style={{ marginTop: 6, fontSize: 13 }}>
              Conservative Mode:{' '}
              <strong style={{ color: r.conservativeMode ? 'var(--warn)' : 'var(--good)' }}>
                {r.conservativeMode ? 'Yes — correlated adds blocked' : 'No'}
              </strong>
            </div>
            {r.lastAccountRiskAction && (
              <div style={{ marginTop: 6, fontSize: 12, color: 'var(--muted)' }}>
                Last account risk action: <span style={{ color: 'var(--text)' }}>{r.lastAccountRiskAction}</span>
              </div>
            )}
            {r.lastReassessmentAction && (
              <div style={{ marginTop: 4, fontSize: 12, color: 'var(--muted)' }}>
                Last trade reassessment: <span style={{ color: 'var(--text)' }}>{r.lastReassessmentAction}</span>
              </div>
            )}
            {r.lastRejectedReason && (
              <div style={{ marginTop: 4, fontSize: 12, color: 'var(--muted)' }}>
                Last trade rejection: <span style={{ color: 'var(--warn)' }}>{r.lastRejectedReason}</span>
              </div>
            )}
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
