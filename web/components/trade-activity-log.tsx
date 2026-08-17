'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

type TradeActivityRow = {
  id: string;
  created_at: string;
  event_type: 'opened' | 'closed' | 'partial_closed' | 'manual_close_executed' | string;
  instrument: string | null;
  trade_id: string | null;
  side: 'long' | 'short' | null;
  units: number | null;
  units_closed: number | null;
  entry_price: number | null;
  exit_price: number | null;
  realized_pl: number | null;
  reason: string | null;
  candidate_signal_id?: string | null;
  lifecycle?: {
    id: string;
    broker_trade_id: string;
    candidate_signal_id: string | null;
    signal_observation_id: string | null;
    d1_state: string | null;
    h4_state: string | null;
    h1_state: string | null;
    h1_momentum: Record<string, unknown> | null;
    m5_authorization: Record<string, unknown> | null;
    m5_trigger_age_bars: number | null;
    po3_stage: string | null;
    htf_liquidity_condition: Record<string, unknown> | null;
    exit_reason: string | null;
    realized_r: number | null;
    mfe_pips: number | null;
    mae_pips: number | null;
    mfe_r: number | null;
    mae_r: number | null;
    failure_reasons: string[] | null;
    learning_adjustment: Record<string, unknown> | null;
    applied_learning_audit_id: string | null;
    learning_applied: boolean;
    entry_context: Record<string, unknown> | null;
  } | null;
};

type ActivityResponse = {
  ok?: boolean;
  rows?: TradeActivityRow[];
  tradingDateKey?: string | null;
  timeZone?: string;
  syncedClosed?: number;
  syncWarning?: string | null;
  refreshedAt?: string;
  error?: string;
};

function displayPair(pair: string | null): string {
  if (!pair) return '—';
  return pair.replace('_', '/');
}

function displayEvent(eventType: string): string {
  if (eventType === 'opened') return 'OPENED';
  if (eventType === 'partial_closed') return 'PARTIAL CLOSE';
  if (eventType === 'manual_close_executed' || eventType === 'closed') return 'CLOSED';
  return eventType.replace(/_/g, ' ').toUpperCase();
}

function eventStyle(eventType: string): React.CSSProperties {
  if (eventType === 'opened') {
    return { background: '#0d3320', color: '#2dff7a', border: '1px solid #1a5c38' };
  }
  if (eventType === 'partial_closed') {
    return { background: '#2d2200', color: '#ffcc00', border: '1px solid #5c4600' };
  }
  return { background: '#0d1f32', color: '#4db8ff', border: '1px solid #1a4060' };
}

function formatPrice(value: number | null, pair: string | null): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (pair?.includes('JPY')) return value.toFixed(3);
  return value.toFixed(5);
}

function compactTradeId(value: string | null): string {
  if (!value) return '—';
  if (value.length <= 12) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function formatTradingDate(value: string | null): string {
  if (!value) return 'Today';
  const [year, month, day] = value.split('-').map(Number);
  if (![year, month, day].every(Number.isFinite)) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(year, month - 1, day));
}

function valueText(value: unknown): string {
  if (value == null || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(3);
  if (typeof value === 'string') return value.replace(/_/g, ' ');
  return JSON.stringify(value);
}

function Detail({ label, value }: { label: string; value: unknown }) {
  return (
    <div style={{ minWidth: 150 }}>
      <div style={{ color: 'var(--muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ color: 'var(--text)', fontSize: 11, marginTop: 3, overflowWrap: 'anywhere' }}>{valueText(value)}</div>
    </div>
  );
}

export function TradeActivityLog({ hasBroker }: { hasBroker: boolean }) {
  const [rows, setRows] = useState<TradeActivityRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const [tradingDateKey, setTradingDateKey] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/scanner/trade-activity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
        cache: 'no-store',
      });
      const data = await response.json() as ActivityResponse;
      if (!response.ok || data.ok !== true) {
        throw new Error(data.error || `HTTP ${response.status}`);
      }
      setRows(Array.isArray(data.rows) ? data.rows : []);
      setWarning(data.syncWarning ?? null);
      setTradingDateKey(data.tradingDateKey ?? null);
      setRefreshedAt(data.refreshedAt ?? new Date().toISOString());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 30_000);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refresh]);

  const visibleRows = useMemo(() => rows.slice(0, 50), [rows]);

  return (
    <section
      style={{
        background: 'var(--panel)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        padding: 20,
      }}
      aria-live="polite"
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: 16,
          flexWrap: 'wrap',
          marginBottom: 14,
        }}
      >
        <div>
          <h2 style={{ margin: 0, fontSize: 18 }}>Today&apos;s trade activity</h2>
          <p style={{ color: 'var(--muted)', margin: '5px 0 0', fontSize: 13, lineHeight: 1.5 }}>
            Opens, partial closes, and closes recorded today in New York time. Older trades remain in Trade logs.
          </p>
          <div style={{ color: 'var(--muted)', marginTop: 5, fontSize: 11 }}>
            Trading date: {formatTradingDate(tradingDateKey)} ET
            {refreshedAt ? ` · Last refreshed ${new Date(refreshedAt).toLocaleString()}` : ''}
          </div>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          style={{
            padding: '8px 16px',
            background: 'var(--bg)',
            color: 'var(--text)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            fontFamily: 'inherit',
            fontWeight: 600,
            fontSize: 12,
            cursor: loading ? 'wait' : 'pointer',
          }}
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {warning && (
        <div
          style={{
            padding: '9px 12px',
            marginBottom: 12,
            background: '#2d2200',
            border: '1px solid #5c4600',
            borderRadius: 7,
            color: '#ffcc66',
            fontSize: 12,
          }}
        >
          {warning}
        </div>
      )}

      {error && (
        <div
          style={{
            padding: '10px 14px',
            background: '#320d0d',
            border: '1px solid #5c1a1a',
            borderRadius: 7,
            color: 'var(--bad)',
            fontSize: 13,
          }}
        >
          <strong>Trade activity unavailable:</strong> {error}
        </div>
      )}

      {!error && !loading && visibleRows.length === 0 && (
        <div
          style={{
            padding: 22,
            background: 'var(--bg)',
            border: '1px dashed var(--border)',
            borderRadius: 8,
            textAlign: 'center',
            color: 'var(--muted)',
            fontSize: 13,
          }}
        >
          {hasBroker
            ? 'No trades have been opened or closed today.'
            : 'Connect a broker to begin documenting today’s trade activity.'}
        </div>
      )}

      {!error && visibleRows.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 940 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                {['Time', 'Pair', 'Event', 'Direction', 'Entry', 'Exit', 'P/L', 'Trade ID', 'ICT review'].map((label) => (
                  <th
                    key={label}
                    style={{
                      padding: '9px 10px',
                      textAlign: 'left',
                      color: 'var(--muted)',
                      fontSize: 11,
                      textTransform: 'uppercase',
                      letterSpacing: '0.6px',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => {
                const lifecycle = row.lifecycle;
                const momentum = lifecycle?.h1_momentum || {};
                const authorization = lifecycle?.m5_authorization || {};
                const liquidity = lifecycle?.htf_liquidity_condition || {};
                return (
                <tr key={row.id} style={{ borderBottom: '1px solid rgba(128,128,160,0.15)' }}>
                  <td style={{ padding: '11px 10px', color: 'var(--muted)', fontSize: 12, whiteSpace: 'nowrap' }}>
                    {new Date(row.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}
                  </td>
                  <td style={{ padding: '11px 10px', color: 'var(--text)', fontWeight: 800, fontSize: 13 }}>
                    {displayPair(row.instrument)}
                  </td>
                  <td style={{ padding: '11px 10px' }}>
                    <span
                      style={{
                        ...eventStyle(row.event_type),
                        display: 'inline-block',
                        borderRadius: 6,
                        padding: '4px 8px',
                        fontSize: 11,
                        fontWeight: 800,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {displayEvent(row.event_type)}
                    </span>
                  </td>
                  <td style={{ padding: '11px 10px', fontSize: 12, fontWeight: 700, color: row.side === 'long' ? '#2dff7a' : row.side === 'short' ? '#ff6666' : 'var(--muted)' }}>
                    {row.side?.toUpperCase() ?? '—'}
                  </td>
                  <td style={{ padding: '11px 10px', color: 'var(--text)', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
                    {formatPrice(row.entry_price, row.instrument)}
                  </td>
                  <td style={{ padding: '11px 10px', color: 'var(--text)', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
                    {formatPrice(row.exit_price, row.instrument)}
                  </td>
                  <td style={{ padding: '11px 10px', fontFamily: 'ui-monospace, monospace', fontSize: 12, fontWeight: 800, color: row.realized_pl == null ? 'var(--muted)' : row.realized_pl >= 0 ? '#2dff7a' : '#ff6666' }}>
                    {row.realized_pl == null ? '—' : `${row.realized_pl >= 0 ? '+' : ''}$${row.realized_pl.toFixed(2)}`}
                  </td>
                  <td title={row.trade_id ?? undefined} style={{ padding: '11px 10px', color: 'var(--muted)', fontFamily: 'ui-monospace, monospace', fontSize: 11 }}>
                    {compactTradeId(row.trade_id)}
                  </td>
                  <td style={{ padding: '8px 10px', fontSize: 11 }}>
                    <details>
                      <summary style={{ color: lifecycle ? '#4db8ff' : 'var(--muted)', cursor: lifecycle ? 'pointer' : 'default', whiteSpace: 'nowrap' }}>
                        {lifecycle ? 'Open review' : 'Awaiting link'}
                      </summary>
                      {lifecycle && (
                        <div style={{ marginTop: 10, width: 680, maxWidth: '75vw', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, padding: 12, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 7 }}>
                          <Detail label="Candidate ID" value={lifecycle.candidate_signal_id || row.candidate_signal_id} />
                          <Detail label="Broker trade ID" value={lifecycle.broker_trade_id} />
                          <Detail label="D1 / H4 / H1" value={`${valueText(lifecycle.d1_state)} / ${valueText(lifecycle.h4_state)} / ${valueText(lifecycle.h1_state)}`} />
                          <Detail label="H1 active momentum" value={`${valueText(momentum.activeDirection)} · ${valueText(momentum.phase)} · aligned ${valueText(momentum.aligned)}`} />
                          <Detail label="M5 authorization" value={`${valueText(authorization.mode)} · age ${valueText(lifecycle.m5_trigger_age_bars)} bars`} />
                          <Detail label="PO3 stage" value={lifecycle.po3_stage} />
                          <Detail label="HTF liquidity" value={liquidity} />
                          <Detail label="Exit / realized R" value={`${valueText(lifecycle.exit_reason)} · ${valueText(lifecycle.realized_r)}R`} />
                          <Detail label="MFE" value={`${valueText(lifecycle.mfe_pips)} pips · ${valueText(lifecycle.mfe_r)}R`} />
                          <Detail label="MAE" value={`${valueText(lifecycle.mae_pips)} pips · ${valueText(lifecycle.mae_r)}R`} />
                          <Detail label="Failure reasons" value={(lifecycle.failure_reasons || []).join(', ') || 'none'} />
                          <Detail label="Learning adjustment" value={lifecycle.learning_applied ? `applied · ${lifecycle.applied_learning_audit_id || 'audit pending'}` : 'pending'} />
                        </div>
                      )}
                    </details>
                  </td>
                </tr>
              );})}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
