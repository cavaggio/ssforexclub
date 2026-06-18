/**
 * web/components/futures-status-panel.tsx
 *
 * Client panel shared by the Futures/NinjaTrader and Topstep tabs. Renders the
 * connection + execution states and (when connected) fetches live status from
 * the provider proxy (/api/<provider>/status). The Execute button is shown ONLY
 * when every live gate passes (provider enabled + cloud allowed + live flag +
 * a connected account). All credentials stay server-side; this panel only ever
 * sees sanitized account/position data.
 */

'use client';

import { useCallback, useEffect, useState } from 'react';

type Provider = 'ninjatrader' | 'topstep';

export type FuturesGate = {
  enabled: boolean;            // provider master flag
  liveExecutionAllowed: boolean; // every gate passed → execution permitted
  hasConnection: boolean;
  environment: string | null;  // sim | live | evaluation | funded
  complianceMessage?: string | null; // shown when execution is blocked by rules
};

type StatusResponse = {
  ok: boolean;
  enabled?: boolean;
  mode?: string;
  accounts?: Array<Record<string, unknown>>;
  positions?: Array<Record<string, unknown>>;
  executionAllowed?: boolean;
  executionReason?: string;
  error?: string;
};

function Badge({ tone, children }: { tone: 'good' | 'bad' | 'warn' | 'muted'; children: React.ReactNode }) {
  const colors = {
    good: { bg: '#0d3320', bd: '#1a5c38', fg: 'var(--good)' },
    bad: { bg: '#320d0d', bd: '#5c1a1a', fg: 'var(--bad)' },
    warn: { bg: '#33270d', bd: '#5c481a', fg: '#e0b341' },
    muted: { bg: 'var(--border)', bd: 'var(--border)', fg: 'var(--muted)' },
  }[tone];
  return (
    <span style={{ padding: '3px 10px', borderRadius: 20, fontSize: 12, fontWeight: 700, background: colors.bg, border: `1px solid ${colors.bd}`, color: colors.fg }}>
      {children}
    </span>
  );
}

export function FuturesStatusPanel({ provider, providerLabel, gate }: { provider: Provider; providerLabel: string; gate: FuturesGate }) {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!gate.hasConnection || !gate.enabled) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/${provider}/status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      setStatus(await res.json());
    } catch (err) {
      setStatus({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setLoading(false);
    }
  }, [provider, gate.hasConnection, gate.enabled]);

  useEffect(() => { void refresh(); }, [refresh]);

  // ─── connection-state banner ──────────────────────────────────────────────
  let connectionBadge: React.ReactNode;
  if (!gate.hasConnection) connectionBadge = <Badge tone="muted">Not connected</Badge>;
  else if (status && status.ok === false) connectionBadge = <Badge tone="bad">Credential validation failed</Badge>;
  else if (!gate.enabled) connectionBadge = <Badge tone="warn">Connected — provider disabled</Badge>;
  else connectionBadge = <Badge tone="good">Connected</Badge>;

  const isLiveMode = gate.environment === 'live' || gate.environment === 'funded';
  const modeBadge = gate.environment
    ? <Badge tone={isLiveMode ? 'warn' : 'muted'}>{isLiveMode ? 'Live / Funded mode' : 'Paper / Sim mode'}</Badge>
    : null;

  const executionBadge = gate.liveExecutionAllowed
    ? <Badge tone="good">Execution enabled</Badge>
    : <Badge tone="bad">Trading disabled</Badge>;

  const accounts = status?.accounts ?? [];
  const positions = status?.positions ?? [];
  const selectedAccount = accounts[0] as Record<string, unknown> | undefined;

  return (
    <section style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 10, padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ margin: 0, fontSize: 16 }}>{providerLabel} — connection status</h3>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {connectionBadge}{modeBadge}{executionBadge}
        </div>
      </div>

      {!gate.liveExecutionAllowed && gate.complianceMessage && (
        <div style={{ padding: '10px 14px', background: '#33270d', border: '1px solid #5c481a', color: '#e0b341', borderRadius: 6, fontSize: 13 }}>
          {gate.complianceMessage}
        </div>
      )}

      {gate.hasConnection && gate.enabled && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
            <Stat label="Selected account" value={selectedAccount ? String(selectedAccount.name ?? selectedAccount.id ?? '—') : (loading ? '…' : '—')} />
            <Stat label="Balance / Equity" value={selectedAccount ? formatMoney(selectedAccount.balance ?? selectedAccount.equity) : '—'} />
            <Stat label="Open positions" value={loading ? '…' : String(positions.length)} />
          </div>

          {status?.ok === false && (
            <div style={{ padding: '10px 14px', background: '#320d0d', border: '1px solid #5c1a1a', color: 'var(--bad)', borderRadius: 6, fontSize: 13 }}>
              {status.error || 'Could not load live status.'}
            </div>
          )}

          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <button onClick={() => void refresh()} disabled={loading} style={ghostBtn}>{loading ? 'Refreshing…' : 'Refresh'}</button>
            <button
              disabled={!gate.liveExecutionAllowed}
              title={gate.liveExecutionAllowed ? 'Execute a futures order' : 'Execution is disabled until all live gates pass'}
              style={{ ...execBtn, opacity: gate.liveExecutionAllowed ? 1 : 0.5, cursor: gate.liveExecutionAllowed ? 'pointer' : 'not-allowed' }}
            >
              Execute (gated)
            </button>
          </div>
        </>
      )}

      <p style={{ color: 'var(--muted)', fontSize: 12, margin: 0 }}>
        Latest futures signals appear here once analysis is wired for this account. Execution is permitted
        only when the provider is enabled, the account validates, and the live-execution gate is open.
      </p>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '1px', fontWeight: 700 }}>{label}</span>
      <span style={{ fontSize: 15, fontWeight: 700 }}>{value}</span>
    </div>
  );
}

function formatMoney(v: unknown): string {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return '—';
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const ghostBtn: React.CSSProperties = { padding: '8px 16px', background: 'transparent', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, fontFamily: 'inherit', fontWeight: 700, fontSize: 13 };
const execBtn: React.CSSProperties = { padding: '8px 20px', background: 'var(--accent)', color: '#001a33', border: 'none', borderRadius: 6, fontFamily: 'inherit', fontWeight: 700, fontSize: 13 };
