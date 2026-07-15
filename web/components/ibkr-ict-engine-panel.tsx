/**
 * web/components/ibkr-ict-engine-panel.tsx
 *
 * Shadow-first ICT futures panel. It reads the sanitized ICT engine snapshot
 * embedded in the IBKR diagnostics response. No credentials reach the browser.
 */

'use client';

import { useCallback, useEffect, useState } from 'react';

type Setup = {
  symbol: string;
  name: string;
  assetClass: string;
  status: string;
  direction?: string | null;
  confidence?: number;
  rr?: number | null;
  entry?: number | null;
  stopLoss?: number | null;
  target?: number | null;
  reason?: string | null;
};

type EngineSnapshot = {
  mode?: string;
  watchlist?: string[];
  generatedAt?: string;
  setups?: Setup[];
  message?: string;
};

type Diagnostics = {
  ok: boolean;
  ictEngine?: EngineSnapshot;
  message?: string;
};

const DEFAULT_SETUPS: Setup[] = [
  { symbol: 'MNQ', name: 'Micro Nasdaq-100', assetClass: 'Index', status: 'waiting_for_gateway' },
  { symbol: 'MES', name: 'Micro S&P 500', assetClass: 'Index', status: 'waiting_for_gateway' },
  { symbol: 'MYM', name: 'Micro Dow', assetClass: 'Index', status: 'waiting_for_gateway' },
  { symbol: 'M2K', name: 'Micro Russell 2000', assetClass: 'Index', status: 'waiting_for_gateway' },
  { symbol: 'MGC', name: 'Micro Gold', assetClass: 'Gold', status: 'waiting_for_gateway' },
];

export function IbkrIctEnginePanel({ enabled, hasConnection }: { enabled: boolean; hasConnection: boolean }) {
  const [engine, setEngine] = useState<EngineSnapshot | null>(null);
  const [loading, setLoading] = useState(false);

  const canScan = enabled && hasConnection;
  const scan = useCallback(async () => {
    if (!canScan) return;
    setLoading(true);
    try {
      const res = await fetch('/api/ninjatrader/diagnostics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const json = (await res.json().catch(() => ({ ok: false }))) as Diagnostics;
      setEngine(json.ictEngine ?? { mode: 'shadow', setups: DEFAULT_SETUPS, message: json.message || 'IBKR gateway did not return market data.' });
    } catch {
      setEngine({ mode: 'shadow', setups: DEFAULT_SETUPS, message: 'Unable to reach the IBKR futures scanner.' });
    } finally {
      setLoading(false);
    }
  }, [canScan]);

  useEffect(() => { void scan(); }, [scan]);

  const setups = engine?.setups?.length ? engine.setups : DEFAULT_SETUPS;

  return (
    <section style={panel}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 16 }}>ICT Indices & Gold Engine</h3>
          <p style={{ color: 'var(--muted)', margin: '6px 0 0', fontSize: 13 }}>
            Liquidity sweep → displacement → MSS → FVG/OB retracement. Minimum planned R:R: 1.5.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={badge}>{(engine?.mode || 'shadow').toUpperCase()}</span>
          <button onClick={() => void scan()} disabled={!canScan || loading} style={{ ...button, opacity: canScan ? 1 : 0.5 }}>
            {loading ? 'Scanning…' : 'Run ICT scan'}
          </button>
        </div>
      </div>

      {engine?.message && <div style={notice}>{engine.message}</div>}

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr>
              {['Contract', 'Market', 'State', 'Bias', 'Confidence', 'R:R', 'Entry / SL / TP'].map((h) => (
                <th key={h} style={th}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {setups.map((s) => (
              <tr key={s.symbol}>
                <td style={td}><strong>{s.symbol}</strong><div style={muted}>{s.name}</div></td>
                <td style={td}>{s.assetClass}</td>
                <td style={td}>{labelStatus(s.status)}</td>
                <td style={td}>{s.direction ? s.direction.toUpperCase() : '—'}</td>
                <td style={td}>{Number.isFinite(s.confidence) ? `${s.confidence}%` : '—'}</td>
                <td style={td}>{Number.isFinite(s.rr) ? Number(s.rr).toFixed(2) : '—'}</td>
                <td style={td}>{formatPlan(s)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p style={{ color: 'var(--muted)', margin: 0, fontSize: 12, lineHeight: 1.5 }}>
        Micro contracts are the default watchlist for safer position sizing. Front-month contract resolution,
        rollover checks, tick values, and margin validation stay inside the futures connector.
      </p>
    </section>
  );
}

function labelStatus(status: string): string {
  return status.replaceAll('_', ' ');
}

function formatPlan(s: Setup): string {
  if (![s.entry, s.stopLoss, s.target].every((v) => Number.isFinite(v))) return s.reason || '—';
  return `${s.entry} / ${s.stopLoss} / ${s.target}`;
}

const panel: React.CSSProperties = { background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 10, padding: 24, display: 'flex', flexDirection: 'column', gap: 16 };
const badge: React.CSSProperties = { padding: '4px 10px', borderRadius: 20, fontSize: 11, fontWeight: 800, background: 'var(--border)', color: 'var(--muted)' };
const button: React.CSSProperties = { padding: '8px 16px', background: 'var(--accent)', color: '#001a33', border: 'none', borderRadius: 6, fontFamily: 'inherit', fontWeight: 700, fontSize: 13, cursor: 'pointer' };
const notice: React.CSSProperties = { padding: '10px 14px', borderRadius: 6, background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--muted)', fontSize: 13 };
const th: React.CSSProperties = { textAlign: 'left', padding: '10px 8px', borderBottom: '1px solid var(--border)', color: 'var(--muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.8px' };
const td: React.CSSProperties = { padding: '12px 8px', borderBottom: '1px solid var(--border)', verticalAlign: 'top' };
const muted: React.CSSProperties = { color: 'var(--muted)', fontSize: 11, marginTop: 2 };
