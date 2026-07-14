/**
 * Signal Stack V3 — Edge Intelligence dashboard panel.
 *
 * Reads the same normalized trade activity lifecycle used by the dashboard's
 * open/close log, then renders attribution and recent trade outcomes.
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import type { AttributionReport, EdgeSnapshot, GroupSummary } from '@/lib/edgeAnalytics';
import { AITradeIntelligencePanel } from './ai-trade-intelligence-panel';

type SourceMeta = {
  eventRows: number;
  syncedClosed: number;
  syncWarning: string | null;
};

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; report: AttributionReport; source: SourceMeta };

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
      setState({
        kind: 'ready',
        report: json.report as AttributionReport,
        source: {
          eventRows: Number(json?.source?.eventRows ?? 0),
          syncedClosed: Number(json?.source?.syncedClosed ?? 0),
          syncWarning: typeof json?.source?.syncWarning === 'string' ? json.source.syncWarning : null,
        },
      });
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

  const report = state.report;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 800 }}>Edge Intelligence</h1>
          <p style={{ margin: '4px 0 0', color: 'var(--muted)', fontSize: 13 }}>
            Where your strategy makes — and loses — money, attributed from the same trade opens and closes shown in Trade Activity.
          </p>
        </div>
        <button onClick={() => void load()} style={btn}>Refresh</button>
      </div>

      <SourceCard source={state.source} generatedAt={report.generatedAt} />
      <AITradeIntelligencePanel report={report} />
      <OverallCard report={report} />
      <RecentTradesCard trades={report.recentTrades} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
        <BreakdownCard title="Instruments" best={report.edge.bestPairs} worst={report.edge.worstPairs} />
        <BreakdownCard title="Sessions" best={report.edge.bestSessions} worst={report.edge.worstSessions} />
        <BreakdownCard title="Market regimes" best={report.edge.bestRegimes} worst={report.edge.worstRegimes} />
        <BreakdownCard title="Conditions" best={report.edge.bestConditions} worst={report.edge.worstConditions} />
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

function SourceCard({ source, generatedAt }: { source: SourceMeta; generatedAt: string }) {
  return (
    <section
      style={{
        background: 'rgba(77,184,255,0.05)',
        border: '1px solid #1a4060',
        borderRadius: 10,
        padding: '11px 14px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        flexWrap: 'wrap',
        fontSize: 12,
      }}
    >
      <div>
        <strong style={{ color: 'var(--accent)' }}>Connected to Trade Activity</strong>
        <span style={{ color: 'var(--muted)' }}> · {source.eventRows} open/close event row(s) loaded</span>
        {source.syncedClosed > 0 && (
          <span style={{ color: 'var(--good)' }}> · {source.syncedClosed} broker closure(s) synchronized</span>
        )}
      </div>
      <span style={{ color: 'var(--muted)' }}>Updated {new Date(generatedAt).toLocaleString()}</span>
      {source.syncWarning && (
        <div style={{ width: '100%', color: 'var(--warn)', borderTop: '1px solid rgba(255,204,0,0.2)', paddingTop: 8 }}>
          {source.syncWarning}
        </div>
      )}
    </section>
  );
}

function OverallCard({ report }: { report: AttributionReport }) {
  const overall = report.overall;
  const stat = (label: string, value: string, color?: string) => (
    <div style={{ flex: '1 1 120px' }}>
      <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 800, color: color || 'var(--text)' }}>{value}</div>
    </div>
  );
  const pnlColor = (overall.totalPnl ?? 0) > 0
    ? 'var(--good)'
    : (overall.totalPnl ?? 0) < 0
      ? 'var(--bad)'
      : 'var(--text)';

  return (
    <section style={card}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20 }}>
        {stat('Trades', String(overall.trades))}
        {stat('Closed', String(overall.resolved))}
        {stat('Scored outcomes', String(overall.outcomes))}
        {stat('Win rate', overall.winRate != null ? `${overall.winRate}%` : '—', overall.winRate != null && overall.winRate >= 50 ? 'var(--good)' : 'var(--warn)')}
        {stat('Wins / Losses', `${overall.wins} / ${overall.losses}`)}
        {stat('Avg P/L', overall.avgPnl != null ? `${overall.avgPnl >= 0 ? '+' : ''}${overall.avgPnl}` : '—', pnlColor)}
        {stat('Total P/L', overall.totalPnl != null ? `${overall.totalPnl >= 0 ? '+' : ''}${overall.totalPnl}` : '—', pnlColor)}
      </div>
    </section>
  );
}

function RecentTradesCard({ trades }: { trades: EdgeSnapshot[] }) {
  return (
    <section style={card}>
      <div style={{ marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 800 }}>Recent trade lifecycle</h3>
        <p style={{ margin: '4px 0 0', color: 'var(--muted)', fontSize: 12 }}>
          Entry conditions and close outcomes reconstructed from Trade Activity by broker trade ID.
        </p>
      </div>
      {trades.length === 0 ? (
        <div style={{ color: 'var(--muted)', fontSize: 12 }}>No documented trade opens or closes yet.</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', minWidth: 760, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                {['Pair', 'Direction', 'Opened', 'Closed', 'Status', 'P/L'].map((label) => (
                  <th key={label} style={th}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {trades.map((trade, index) => {
                const pnlColor = trade.pnl == null ? 'var(--muted)' : trade.pnl >= 0 ? 'var(--good)' : 'var(--bad)';
                return (
                  <tr key={`${trade.tradeId ?? trade.pair ?? 'trade'}-${trade.entryTime ?? index}`} style={{ borderBottom: '1px solid rgba(128,128,160,0.15)' }}>
                    <td style={{ ...td, fontWeight: 800 }}>{trade.pair?.replace('_', '/') ?? '—'}</td>
                    <td style={{ ...td, color: trade.direction === 'long' ? 'var(--good)' : trade.direction === 'short' ? 'var(--bad)' : 'var(--muted)', fontWeight: 700 }}>
                      {trade.direction?.toUpperCase() ?? '—'}
                    </td>
                    <td style={td}>{trade.entryTime ? new Date(trade.entryTime).toLocaleString() : '—'}</td>
                    <td style={td}>{trade.exitTime ? new Date(trade.exitTime).toLocaleString() : '—'}</td>
                    <td style={td}>
                      <span style={{ color: trade.resolved ? 'var(--accent)' : 'var(--warn)', fontWeight: 800 }}>
                        {trade.resolved ? (trade.winLoss?.toUpperCase() ?? 'CLOSED') : 'OPEN'}
                      </span>
                    </td>
                    <td style={{ ...td, color: pnlColor, fontWeight: 800 }}>
                      {trade.pnl == null ? '—' : `${trade.pnl >= 0 ? '+' : ''}${trade.pnl.toFixed(2)}`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
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
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>Not enough scored outcomes.</div>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {items.map((group) => (
            <li key={group.key} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, gap: 8 }}>
              <span style={{ color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{group.key}</span>
              <span style={{ color: 'var(--muted)', flexShrink: 0 }}>
                {group.winRate != null ? `${group.winRate}%` : '—'}
                {group.avgPnl != null ? ` · ${group.avgPnl >= 0 ? '+' : ''}${group.avgPnl}` : ''}
                {` · n${group.trades}`}
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

const th: React.CSSProperties = {
  padding: '8px 10px',
  textAlign: 'left',
  color: 'var(--muted)',
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
  whiteSpace: 'nowrap',
};

const td: React.CSSProperties = {
  padding: '10px',
  color: 'var(--text)',
  fontSize: 11,
  whiteSpace: 'nowrap',
};
