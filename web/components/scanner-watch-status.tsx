'use client';

import { useCallback, useEffect, useState } from 'react';

type WatchTier = 'hot' | 'near';

type WatchSignal = {
  pair?: string;
  instrument?: string;
  direction?: 'long' | 'short' | 'neutral' | null;
  reason?: string;
  rejectionReasons?: string[];
  confidence?: number;
  tpHitConfidence?: number;
  score?: number;
  v3Score?: number;
  expectedRR?: number;
  rr?: number;
  riskReward?: number;
  spreadPips?: number;
  entryTiming?: { status?: string; reason?: string } | null;
  alignment?: { timeframeAlignmentScore?: number } | null;
  v3?: { score?: number } | null;
  fibonacci?: {
    enabled?: boolean;
    timeframeUsed?: string | null;
    swingHigh?: number | null;
    swingLow?: number | null;
    retracementLevels?: { level382?: number | null } | null;
  } | null;
  dashboardWatchTier?: { tier?: string; reason?: string } | null;
  watchTier?: { tier?: string; reason?: string } | null;
};

type WatchScanResponse = {
  ok?: boolean;
  scan?: {
    nearQualified?: WatchSignal[];
    hotWatch?: WatchSignal[];
    meta?: {
      scannedAt?: string;
      nearQualifiedCount?: number;
      hotWatchCount?: number;
    };
  };
  error?: string;
};

function displayPair(signal: WatchSignal): string {
  const pair = String(signal.pair || signal.instrument || 'UNKNOWN');
  if (pair === 'XAU_USD') return 'Gold';
  if (pair === 'XAG_USD') return 'Silver';
  return pair.replace('_', '/');
}

function finite(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function formatWatchPrice(signal: WatchSignal, value: unknown): string {
  const parsed = finite(value);
  if (parsed == null) return '—';
  const pair = String(signal.pair || signal.instrument || '').toUpperCase();
  if (pair === 'XAU_USD' || pair === 'XAG_USD') return parsed.toFixed(2);
  if (pair.includes('JPY')) return parsed.toFixed(3);
  return parsed.toFixed(5);
}

function watchReason(signal: WatchSignal, tier: WatchTier): string {
  return String(
    signal.dashboardWatchTier?.reason ||
    signal.watchTier?.reason ||
    signal.entryTiming?.reason ||
    signal.reason ||
    signal.rejectionReasons?.[0] ||
    (tier === 'hot'
      ? 'Waiting for a fresh trigger or confirmed retest.'
      : 'Setup is developing but not yet trigger-ready.'),
  );
}

function WatchCard({ signal, tier }: { signal: WatchSignal; tier: WatchTier }) {
  const hot = tier === 'hot';
  const direction = signal.direction === 'long' || signal.direction === 'short'
    ? signal.direction
    : 'neutral';
  const confidence = finite(signal.tpHitConfidence, signal.confidence);
  const v3Score = finite(signal.v3Score, signal.v3?.score, signal.score);
  const alignment = finite(signal.alignment?.timeframeAlignmentScore);
  const rr = finite(signal.expectedRR, signal.rr, signal.riskReward);
  const timing = signal.entryTiming?.status?.replace(/_/g, ' ') || (hot ? 'trigger pending' : 'setup developing');
  const fibonacci = signal.fibonacci;

  return (
    <article
      style={{
        padding: 16,
        borderRadius: 10,
        background: hot ? '#241400' : '#0b1b2b',
        border: hot ? '1px solid #7a4600' : '1px solid #1a4d73',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 17, fontWeight: 800, color: 'var(--text)' }}>{displayPair(signal)}</div>
          <div style={{ marginTop: 3, fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.7px' }}>
            {timing}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <span
            style={{
              padding: '5px 9px',
              borderRadius: 6,
              background: hot ? '#4a2600' : '#102f48',
              border: hot ? '1px solid #a85d00' : '1px solid #24658f',
              color: hot ? '#ffb347' : '#66c7ff',
              fontSize: 11,
              fontWeight: 800,
            }}
          >
            {hot ? 'HOT WATCH' : 'NEAR QUALIFIED'}
          </span>
          {direction !== 'neutral' && (
            <span
              style={{
                padding: '5px 9px',
                borderRadius: 6,
                background: direction === 'long' ? '#0d3320' : '#320d0d',
                border: direction === 'long' ? '1px solid #1a5c38' : '1px solid #5c1a1a',
                color: direction === 'long' ? '#2dff7a' : '#ff6666',
                fontSize: 11,
                fontWeight: 800,
              }}
            >
              {direction.toUpperCase()}
            </span>
          )}
        </div>
      </div>

      <p style={{ margin: 0, color: '#c7c7df', fontSize: 12, lineHeight: 1.55 }}>
        {watchReason(signal, tier)}
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(75px, 1fr))', gap: 8 }}>
        <Metric label="Alignment" value={alignment == null ? '—' : `${alignment}/100`} />
        <Metric label="V3 score" value={v3Score == null ? '—' : `${v3Score}`} />
        <Metric label="TP confidence" value={confidence == null ? '—' : `${confidence}%`} />
        <Metric label="R:R" value={rr == null ? '—' : `${rr.toFixed(2)}R`} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(75px, 1fr))', gap: 8 }}>
        <Metric label="Fib timeframe" value={fibonacci?.timeframeUsed || '—'} />
        <Metric label="Swing high" value={formatWatchPrice(signal, fibonacci?.swingHigh)} />
        <Metric label="Swing low" value={formatWatchPrice(signal, fibonacci?.swingLow)} />
        <Metric label="Fib 38.2%" value={formatWatchPrice(signal, fibonacci?.retracementLevels?.level382)} />
      </div>

      {signal.spreadPips != null && Number.isFinite(Number(signal.spreadPips)) && (
        <div style={{ fontSize: 11, color: 'var(--muted)' }}>
          Current spread: {Number(signal.spreadPips).toFixed(1)} pips
        </div>
      )}
    </article>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ padding: '8px 9px', background: 'rgba(0,0,0,0.22)', borderRadius: 7 }}>
      <div style={{ fontSize: 9, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.6px' }}>{label}</div>
      <div style={{ marginTop: 3, fontSize: 12, color: 'var(--text)', fontWeight: 700, fontFamily: 'ui-monospace, monospace' }}>{value}</div>
    </div>
  );
}

function EmptyWatch({ tier }: { tier: WatchTier }) {
  return (
    <div
      style={{
        padding: 18,
        background: 'var(--bg)',
        border: '1px dashed var(--border)',
        borderRadius: 8,
        color: 'var(--muted)',
        fontSize: 12,
        lineHeight: 1.5,
        textAlign: 'center',
      }}
    >
      {tier === 'hot'
        ? 'No pairs are currently waiting only on a trigger or retest.'
        : 'No pairs are currently close enough to retain as Near Qualified.'}
    </div>
  );
}

export function ScannerWatchStatus({ hasBroker }: { hasBroker: boolean }) {
  const [hotWatch, setHotWatch] = useState<WatchSignal[]>([]);
  const [nearQualified, setNearQualified] = useState<WatchSignal[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scannedAt, setScannedAt] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!hasBroker) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/scanner/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
        cache: 'no-store',
      });
      const data = await response.json() as WatchScanResponse;
      if (!response.ok || data.ok !== true) {
        throw new Error(data.error || `HTTP ${response.status}`);
      }
      const scan = data.scan || {};
      setHotWatch(Array.isArray(scan.hotWatch) ? scan.hotWatch : []);
      setNearQualified(Array.isArray(scan.nearQualified) ? scan.nearQualified : []);
      setScannedAt(scan.meta?.scannedAt || new Date().toISOString());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [hasBroker]);

  useEffect(() => {
    if (hasBroker) void refresh();
  }, [hasBroker, refresh]);

  return (
    <section style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 10, padding: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap', marginBottom: 14 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18 }}>V3 watch status</h2>
          <p style={{ color: 'var(--muted)', margin: '5px 0 0', fontSize: 13, lineHeight: 1.5, maxWidth: 720 }}>
            Pairs that passed enough setup context to remain monitored are shown here instead of being grouped with fully rejected signals. Watch status is informational and never bypasses execution gates.
          </p>
          {scannedAt && (
            <div style={{ marginTop: 5, color: 'var(--muted)', fontSize: 11 }}>
              Watch scan completed {new Date(scannedAt).toLocaleString()}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={!hasBroker || loading}
          style={{
            padding: '8px 16px',
            background: hasBroker ? 'var(--bg)' : 'var(--border)',
            color: hasBroker ? 'var(--text)' : 'var(--muted)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            fontFamily: 'inherit',
            fontWeight: 700,
            fontSize: 12,
            cursor: !hasBroker ? 'not-allowed' : loading ? 'wait' : 'pointer',
          }}
        >
          {loading ? 'Scanning…' : 'Refresh watch status'}
        </button>
      </div>

      {!hasBroker && (
        <div style={{ padding: 18, background: 'var(--bg)', border: '1px dashed var(--border)', borderRadius: 8, textAlign: 'center', color: 'var(--muted)', fontSize: 12 }}>
          Connect a broker to scan Near Qualified and Hot Watch pairs.
        </div>
      )}

      {error && (
        <div style={{ padding: '10px 14px', background: '#320d0d', border: '1px solid #5c1a1a', borderRadius: 7, color: 'var(--bad)', fontSize: 12 }}>
          <strong>Watch scan unavailable:</strong> {error}
        </div>
      )}

      {hasBroker && !error && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(330px, 1fr))', gap: 14 }}>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <h3 style={{ margin: 0, color: '#ffb347', fontSize: 15 }}>Hot Watch</h3>
              <span style={{ color: '#ffb347', fontWeight: 800, fontSize: 13 }}>{hotWatch.length}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
              {hotWatch.length ? hotWatch.map((signal, index) => (
                <WatchCard key={`hot:${signal.pair || signal.instrument}:${index}`} signal={signal} tier="hot" />
              )) : <EmptyWatch tier="hot" />}
            </div>
          </div>

          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <h3 style={{ margin: 0, color: '#66c7ff', fontSize: 15 }}>Near Qualified</h3>
              <span style={{ color: '#66c7ff', fontWeight: 800, fontSize: 13 }}>{nearQualified.length}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
              {nearQualified.length ? nearQualified.map((signal, index) => (
                <WatchCard key={`near:${signal.pair || signal.instrument}:${index}`} signal={signal} tier="near" />
              )) : <EmptyWatch tier="near" />}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
