/**
 * web/components/edge-intelligence-panel.tsx
 *
 * Signal Stack V3 — Edge Intelligence dashboard panel.
 *
 * Fetches /api/edge-intelligence (the user's own strategy-attribution report)
 * and renders the AI Trade Intelligence briefing plus best/worst breakdowns by
 * instrument, session, market regime, and condition.
 *
 * Read-only: it displays history. Nothing here can place or change a trade.
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import type { AttributionReport, GroupSummary } from '@/lib/edgeAnalytics';
import { AITradeIntelligencePanel } from './ai-trade-intelligence-panel';

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; report: AttributionReport };

export function EdgeIntelligencePanel() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const res = await fetch('/api/edge-intelligence', { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok || !json?.ok) {
        setState({ kind: 'error', message: json?.error || `HTTP ${res.status}` });
        return;
      }
      setState({ kind: 'ready', report: json.report as AttributionReport });
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.kind === 'loading') {
    return <Shell><p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading edge intelligence…</p></Shell>;
  }
  if (state.kind === 'error') {
    return (
      <Shell>
        <p style={{ color: 'var(--bad)', fontSize: 13 }}>Could not load edge intelligence: {state.message}</p>
        <button onClick={() => void load()} style={btn}>Retry</button>
      </Shell>
    );
  }

  const r = state.report;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 800 }}>Edge Intelligence</h1>
          <p style={{ margin: '4px 0 0', color: 'var(--muted)', fontSize: 13 }}>
            Where your strategy makes — and loses — money, attributed across instruments, sessions, regimes, and macro conditions.
          </p>
        </div>
        <button onClick={() => void load()} style={btn}>Refresh</button>
      </div>

      <AITradeIntelligencePanel report={r} />

      <OverallCard report={r} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
        <BreakdownCard title="Instruments" best={r.edge.bestPairs} worst={r.edge.worstPairs} />
        <BreakdownCard title="Sessions" best={r.edge.bestSessions} worst={r.edge.worstSessions} />
        <BreakdownCard title="Market regimes" best={r.edge.bestRegimes} worst={r.edge.worstRegimes} />
        <BreakdownCard title="Conditions" best={r.edge.bestConditions} worst={r.edge.worstConditions} />
      </div>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h1 style={{ margin: 0, fontSize: 20, fontWeight: 800 }}>Edge Intelligence</h1>
      {children}
    </div>
  );
}

function OverallCard({ report }: { report: AttributionReport }) {
  const o = report.overall;
  const stat = (label: string, value: string, color?: string) => (
    <div style={{ flex: '1 1 120px' }}>
      <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 800, color: color || 'var(--text)' }}>{value}</div>
    </div>
  );
  const pnlColor = (o.totalPnl ?? 0) > 0 ? 'var(--good)' : (o.totalPnl ?? 0) < 0 ? 'var(--bad)' : 'var(--text)';
  return (
    <section style={card}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20 }}>
        {stat('Trades', String(o.trades))}
        {stat('Resolved', String(o.resolved))}
        {stat('Win rate', o.winRate != null ? `${o.winRate}%` : '—', o.winRate != null && o.winRate >= 50 ? 'var(--good)' : 'var(--warn)')}
        {stat('Wins / Losses', `${o.wins} / ${o.losses}`)}
        {stat('Avg P/L', o.avgPnl != null ? `${o.avgPnl >= 0 ? '+' : ''}${o.avgPnl}` : '—', pnlColor)}
        {stat('Total P/L', o.totalPnl != null ? `${o.totalPnl >= 0 ? '+' : ''}${o.totalPnl}` : '—', pnlColor)}
      </div>
    </section>
  );
}

function BreakdownCard({ title, best, worst }: { title: string; best: GroupSummary[]; worst: GroupSummary[] }) {
  return (
    <section style={card}>
      <h3 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 800 }}>{title}</h3>
      <Row label="Best" items={best} accent="var(--good)" />
      <div style={{ height: 10 }} />
      <Row label="Worst" items={worst} accent="var(--bad)" />
    </section>
  );
}

function Row({ label, items, accent }: { label: string; items: GroupSummary[]; accent: string }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 800, color: accent, marginBottom: 6 }}>{label}</div>
      {items.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>Not enough data.</div>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {items.map((g) => (
            <li key={g.key} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, gap: 8 }}>
              <span style={{ color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.key}</span>
              <span style={{ color: 'var(--muted)', flexShrink: 0 }}>
                {g.winRate != null ? `${g.winRate}%` : '—'}
                {g.avgPnl != null ? ` · ${g.avgPnl >= 0 ? '+' : ''}${g.avgPnl}` : ''}
                {` · n${g.trades}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const card: React.CSSProperties = {
  background: 'var(--panel)',
  border: '1px solid var(--border)',
  borderRadius: 12,
  padding: 18,
};

const btn: React.CSSProperties = {
  background: 'var(--border)',
  color: 'var(--text)',
  border: '1px solid transparent',
  borderRadius: 6,
  padding: '6px 14px',
  fontSize: 12,
  fontWeight: 700,
  cursor: 'pointer',
};
