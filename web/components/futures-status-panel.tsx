/**
 * web/components/futures-status-panel.tsx
 *
 * Client panel shared by the Futures/NinjaTrader and Topstep tabs. It fetches
 * the provider /diagnostics endpoint and renders state derived ENTIRELY by the
 * pure deriveFuturesView() helper — the single source of truth shared with the
 * server. The Execute button is shown only once credentials validate and is
 * enabled only when every live gate passes. All credentials stay server-side;
 * this panel only ever sees sanitized diagnostic data + a stable error code.
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import { deriveFuturesView } from '@/lib/futuresStatus';

type Provider = 'ninjatrader' | 'topstep';

export type FuturesGate = {
  enabled: boolean;                 // provider master flag (server env)
  liveFlag: boolean;                // live execution permitted by flags (provider-specific)
  liveAck: boolean | null;          // user-level live-trading ack, or null if n/a
  hasConnection: boolean;
  connectionEnvironment: string | null; // stored connection environment
  complianceMessage?: string | null;    // shown when execution is force-disabled
};

type Diagnostics = {
  ok: boolean;
  code?: string;
  message?: string;
  validationStatus?: string;
  environment?: string | null;
  accountMode?: string | null;
  accountCount?: number;
  selectedAccount?: string | null;
  balance?: number | null;
  equity?: number | null;
  openPositions?: number;
  executionAllowed?: boolean;
};

function Badge({ tone, children }: { tone: string; children: React.ReactNode }) {
  const map: Record<string, { bg: string; bd: string; fg: string }> = {
    good: { bg: '#0d3320', bd: '#1a5c38', fg: 'var(--good)' },
    bad: { bg: '#320d0d', bd: '#5c1a1a', fg: 'var(--bad)' },
    warn: { bg: '#33270d', bd: '#5c481a', fg: '#e0b341' },
    muted: { bg: 'var(--border)', bd: 'var(--border)', fg: 'var(--muted)' },
  };
  const c = map[tone] || map.muted;
  return (
    <span style={{ padding: '3px 10px', borderRadius: 20, fontSize: 12, fontWeight: 700, background: c.bg, border: `1px solid ${c.bd}`, color: c.fg }}>
      {children}
    </span>
  );
}

export function FuturesStatusPanel({ provider, providerLabel, gate }: { provider: Provider; providerLabel: string; gate: FuturesGate }) {
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [loading, setLoading] = useState(false);

  const shouldFetch = gate.hasConnection && gate.enabled;

  const refresh = useCallback(async () => {
    if (!shouldFetch) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/${provider}/diagnostics`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      // The API always returns coded JSON — even on 4xx/5xx — never a raw throw.
      const json = (await res.json().catch(() => ({ ok: false, code: 'SCANNER_ERROR', message: 'Unexpected response.' }))) as Diagnostics;
      setDiag(json);
    } catch {
      // Client-side network failure to our own API.
      setDiag({ ok: false, code: 'SCANNER_UNREACHABLE', message: 'Unable to reach scanner service.' });
    } finally {
      setLoading(false);
    }
  }, [provider, shouldFetch]);

  useEffect(() => { void refresh(); }, [refresh]);

  const view = deriveFuturesView({
    enabled: gate.enabled,
    liveFlag: gate.liveFlag,
    liveAck: gate.liveAck,
    hasConnection: gate.hasConnection,
    connectionEnvironment: gate.connectionEnvironment,
    complianceMessage: gate.complianceMessage,
    diagnostics: shouldFetch ? diag : null,
  });

  const accountLabel = diag?.selectedAccount ?? (loading ? '…' : '—');
  const balanceLabel = diag && diag.balance != null ? formatMoney(diag.balance)
    : diag && diag.equity != null ? formatMoney(diag.equity) : '—';
  const positionsLabel = diag && typeof diag.openPositions === 'number' ? String(diag.openPositions) : (loading ? '…' : '0');

  return (
    <section style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 10, padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ margin: 0, fontSize: 16 }}>{providerLabel} — connection status</h3>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Badge tone={view.connection.tone}>{view.connection.label}</Badge>
          <Badge tone={view.mode.tone}>{view.mode.label}</Badge>
          <Badge tone={view.execution.tone}>{view.execution.label}</Badge>
        </div>
      </div>

      {view.message && (
        <div style={{ padding: '10px 14px', borderRadius: 6, fontSize: 13, ...messageStyle(view) }}>
          {view.message}
        </div>
      )}

      {shouldFetch && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
          <Stat label="Selected account" value={accountLabel} />
          <Stat label="Balance / Equity" value={balanceLabel} />
          <Stat label="Open positions" value={positionsLabel} />
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <button onClick={() => void refresh()} disabled={loading || !shouldFetch} style={ghostBtn}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
        {view.executeVisible && (
          <button
            disabled={!view.executeEnabled}
            title={view.executeEnabled ? 'Execute a futures order' : 'Execution is disabled until every live gate passes'}
            style={{ ...execBtn, opacity: view.executeEnabled ? 1 : 0.5, cursor: view.executeEnabled ? 'pointer' : 'not-allowed' }}
          >
            Execute
          </button>
        )}
      </div>
    </section>
  );
}

function messageStyle(view: ReturnType<typeof deriveFuturesView>): React.CSSProperties {
  if (view.connection.tone === 'bad') return { background: '#320d0d', border: '1px solid #5c1a1a', color: 'var(--bad)' };
  if (view.connection.tone === 'warn' || view.execution.tone === 'bad') return { background: '#33270d', border: '1px solid #5c481a', color: '#e0b341' };
  return { background: 'var(--border)', border: '1px solid var(--border)', color: 'var(--muted)' };
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '1px', fontWeight: 700 }}>{label}</span>
      <span style={{ fontSize: 15, fontWeight: 700 }}>{value}</span>
    </div>
  );
}

function formatMoney(v: number): string {
  if (!Number.isFinite(v)) return '—';
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const ghostBtn: React.CSSProperties = { padding: '8px 16px', background: 'transparent', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, fontFamily: 'inherit', fontWeight: 700, fontSize: 13 };
const execBtn: React.CSSProperties = { padding: '8px 20px', background: 'var(--accent)', color: '#001a33', border: 'none', borderRadius: 6, fontFamily: 'inherit', fontWeight: 700, fontSize: 13 };
