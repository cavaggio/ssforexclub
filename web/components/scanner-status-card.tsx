/**
 * web/components/scanner-status-card.tsx
 *
 * Lightweight client card that hits the authenticated `/api/scanner/scan`
 * endpoint on demand and renders a one-line status: qualified count,
 * rejected count, asset-class breakdown, active environment, and the
 * resolver's `reason` string if the call failed.
 *
 * The token never reaches this component — the API route resolves and
 * forwards credentials server-side. This component only sees the result.
 */

'use client';

import { useCallback, useState } from 'react';

type ScanResult = {
  ok: boolean;
  error?: string;
  activeBroker?: string | null;
  activeEnvironment?: string;
  isLiveTrading?: boolean;
  brokerCredentialStatus?: string;
  scan?: {
    qualified?: Array<{ pair: string; assetClass?: string; selectedLogicType?: string }>;
    rejected?: Array<unknown>;
    meta?: Record<string, unknown>;
  };
};

export function ScannerStatusCard({ hasBroker }: { hasBroker: boolean }) {
  const [state, setState] = useState<ScanResult | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError]   = useState<string | null>(null);

  const runScan = useCallback(async () => {
    setPending(true);
    setError(null);
    setState(null);
    try {
      const scannerBaseUrl = process.env.NEXT_PUBLIC_SCANNER_BASE_URL;

      if (!scannerBaseUrl) {
        throw new Error('NEXT_PUBLIC_SCANNER_BASE_URL is not set');
      }

      const res = await fetch(`${scannerBaseUrl}/api/oanda/scan?pairs=EUR_USD,USD_CAD`, {
        method: 'GET',
      });
      const data = (await res.json()) as ScanResult;
      if (!res.ok) {
        setError(data?.error || `HTTP ${res.status}`);
        setState(data);
      } else {
        setState(data);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }, []);

  const qCount = state?.scan?.qualified?.length ?? 0;
  const rCount = state?.scan?.rejected?.length ?? 0;
  const byClass = (state?.scan?.qualified ?? []).reduce<Record<string, number>>((acc, s) => {
    const k = s.selectedLogicType || s.assetClass || 'unknown';
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});

  return (
    <section
      style={{
        background: 'var(--panel)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        padding: 24,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: 16,
          flexWrap: 'wrap',
        }}
      >
        <div>
          <h2 style={{ margin: 0, fontSize: 18 }}>Signal scanner</h2>
          <p style={{ color: 'var(--muted)', marginTop: 6, fontSize: 13, maxWidth: 640 }}>
            Multi-timeframe waterfall + entry-quality + asset-class qualification for forex,
            metals and indices. Runs against the broker account selected in Settings.
          </p>
        </div>
        <button
          type="button"
          onClick={runScan}
          disabled={pending || !hasBroker}
          title={hasBroker ? 'Run a fresh scan' : 'Connect a broker first'}
          style={{
            padding: '10px 20px',
            background: hasBroker ? 'var(--accent)' : 'var(--border)',
            color: hasBroker ? '#001a33' : 'var(--muted)',
            border: 'none',
            borderRadius: 6,
            fontFamily: 'inherit',
            fontWeight: 700,
            fontSize: 13,
            cursor: hasBroker && !pending ? 'pointer' : 'not-allowed',
          }}
        >
          {pending ? 'Scanning…' : 'Run scan'}
        </button>
      </div>

      {!hasBroker && (
        <div
          style={{
            marginTop: 20,
            padding: 24,
            background: 'var(--bg)',
            border: '1px dashed var(--border)',
            borderRadius: 8,
            textAlign: 'center',
          }}
        >
          <div style={{ fontSize: 14, color: 'var(--muted)' }}>
            Connect a broker account in <a href="/dashboard/settings">Settings</a> to enable the scanner.
          </div>
        </div>
      )}

      {hasBroker && !state && !error && !pending && (
        <div
          style={{
            marginTop: 20,
            padding: 24,
            background: 'var(--bg)',
            border: '1px dashed var(--border)',
            borderRadius: 8,
            textAlign: 'center',
          }}
        >
          <div style={{ fontSize: 14, color: 'var(--muted)' }}>
            Press <strong>Run scan</strong> to fetch fresh signals with your active broker connection.
          </div>
        </div>
      )}

      {error && (
        <div
          style={{
            marginTop: 16,
            padding: '12px 16px',
            background: '#320d0d',
            border: '1px solid #5c1a1a',
            color: 'var(--bad)',
            borderRadius: 6,
            fontSize: 13,
          }}
        >
          <strong>Scanner error:</strong> {error}
          {state?.brokerCredentialStatus ? (
            <div style={{ marginTop: 4, color: 'var(--muted)', fontSize: 12 }}>
              Resolver status: {state.brokerCredentialStatus}
            </div>
          ) : null}
        </div>
      )}

      {state?.ok && (
        <div
          style={{
            marginTop: 16,
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
            gap: 12,
          }}
        >
          <StatCell label="Qualified" value={String(qCount)} good />
          <StatCell label="Rejected"  value={String(rCount)} />
          <StatCell label="Mode"       value={(state.activeEnvironment ?? '—').toString()} live={state.isLiveTrading} />
          <StatCell label="Broker"     value={(state.activeBroker ?? '—').toUpperCase()} />
        </div>
      )}

      {state?.ok && Object.keys(byClass).length > 0 && (
        <div style={{ marginTop: 12, fontSize: 12, color: 'var(--muted)' }}>
          By asset class:{' '}
          {Object.entries(byClass).map(([k, v]) => (
            <span key={k} style={{ marginRight: 12 }}>
              <strong style={{ color: 'var(--text)' }}>{k}</strong> {v}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

function StatCell({ label, value, good, live }: { label: string; value: string; good?: boolean; live?: boolean }) {
  return (
    <div
      style={{
        padding: '14px 16px',
        background: 'var(--bg)',
        border: '1px solid var(--border)',
        borderRadius: 8,
      }}
    >
      <div style={{ fontSize: 12, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '1px' }}>
        {label}
      </div>
      <div
        style={{
          marginTop: 6,
          fontSize: 16,
          fontWeight: 700,
          color: live ? 'var(--bad)' : good ? 'var(--good)' : 'var(--text)',
        }}
      >
        {value}
      </div>
    </div>
  );
}
