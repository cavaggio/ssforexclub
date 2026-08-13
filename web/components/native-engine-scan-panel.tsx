'use client';

import type { ReactNode } from 'react';
import { QualifiedExecuteButton } from '@/components/qualified-execute-button';

type Engine = 'ict' | 'ppr';

type Props = {
  engine: Engine;
  qualified: any[];
  watchCandidates: any[];
  rejected: any[];
};

function pairLabel(pair: unknown): string {
  return String(pair || 'UNKNOWN').replace('_', '/');
}

function num(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function price(value: unknown, pair: unknown): string {
  const number = num(value);
  if (number === null) return '—';
  return String(pair || '').includes('JPY') ? number.toFixed(3) : number.toFixed(5);
}

function text(value: unknown, fallback = '—'): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function structureBias(value: unknown): 'bullish' | 'bearish' | 'neutral' {
  const normalized = String(value || '').toLowerCase();
  return normalized === 'bullish' || normalized === 'bearish' ? normalized : 'neutral';
}

function biasLabel(value: unknown): string {
  const bias = structureBias(value);
  return `${bias === 'bullish' ? '▲' : bias === 'bearish' ? '▼' : '◆'} ${bias.toUpperCase()}`;
}

function toneForStatus(status: string): { fg: string; bg: string; border: string } {
  if (status === 'qualified') return { fg: '#2dff7a', bg: '#0d3320', border: '#1a5c38' };
  if (status === 'hot') return { fg: '#ffcc00', bg: '#2d2200', border: '#5c4600' };
  if (status === 'late' || status === 'rejected') return { fg: '#ff7777', bg: '#320d0d', border: '#5c1a1a' };
  return { fg: '#4db8ff', bg: '#0d1f32', border: '#1a4060' };
}

function Badge({ children, status = 'near' }: { children: ReactNode; status?: string }) {
  const tone = toneForStatus(status);
  return (
    <span
      style={{
        display: 'inline-flex',
        padding: '4px 9px',
        borderRadius: 999,
        border: `1px solid ${tone.border}`,
        background: tone.bg,
        color: tone.fg,
        fontSize: 11,
        fontWeight: 800,
        letterSpacing: '0.4px',
        textTransform: 'uppercase',
      }}
    >
      {children}
    </span>
  );
}

function DirectionBadge({ direction }: { direction: 'buy' | 'sell' | 'none' }) {
  const tone = toneForStatus(direction === 'buy' ? 'qualified' : direction === 'sell' ? 'rejected' : 'near');
  return (
    <span
      aria-label={`Trade direction: ${direction === 'none' ? 'no trade' : direction}`}
      style={{
        display: 'inline-flex',
        padding: '6px 12px',
        borderRadius: 7,
        border: `2px solid ${tone.border}`,
        background: tone.bg,
        color: tone.fg,
        fontSize: 13,
        fontWeight: 900,
        letterSpacing: '0.7px',
        textTransform: 'uppercase',
      }}
    >
      Direction · {direction === 'none' ? 'No trade' : direction}
    </span>
  );
}

function Metric({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div style={{ padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg)' }}>
      <div style={{ color: 'var(--muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.7px' }}>{label}</div>
      <div style={{ marginTop: 4, fontSize: 13, fontWeight: 750, fontFamily: "'JetBrains Mono', ui-monospace, monospace" }}>{value}</div>
    </div>
  );
}

function PprCard({ item }: { item: any }) {
  const status = text(item?.status, 'rejected').toLowerCase();
  const daily = item?.dailyBias || item?.ppr?.dailyBias || {};
  const h1 = item?.h1Alignment || item?.ppr?.h1Alignment || {};
  const volume = item?.volume || item?.ppr?.volume || {};
  const manipulation = item?.manipulation || item?.ppr?.manipulation || {};
  const target = item?.liquidityTarget || item?.ppr?.liquidityTarget || {};
  const confirmation = item?.pprConfirmation || {};
  const manipulationTypes = Array.isArray(manipulation?.types)
    ? manipulation.types
    : Array.isArray(confirmation?.manipulationTypes)
      ? confirmation.manipulationTypes
      : manipulation?.type || confirmation?.manipulationType
        ? [manipulation?.type || confirmation?.manipulationType]
        : [];
  const targetSources = Array.isArray(target?.sources)
    ? target.sources
    : Array.isArray(confirmation?.targetSources)
      ? confirmation.targetSources
      : [];
  const rr = num(item?.rr ?? item?.expectedRR);
  const volumeRatio = num(volume?.ratio ?? confirmation?.volumeRatio);
  const distancePips = num(manipulation?.distancePips ?? confirmation?.manipulationDistancePips);

  return (
    <article style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 16, background: 'var(--panel)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 18, fontFamily: "'JetBrains Mono', ui-monospace, monospace" }}>{pairLabel(item?.pair)}</strong>
            <Badge status={status}>{status}</Badge>
            {item?.direction && <Badge status={item.direction === 'long' ? 'qualified' : 'rejected'}>{String(item.direction)}</Badge>}
          </div>
          <div style={{ marginTop: 7, color: 'var(--muted)', fontSize: 12, lineHeight: 1.5 }}>{text(item?.reason)}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 21, fontWeight: 850 }}>{num(item?.confidence) !== null ? `${num(item?.confidence)}%` : '—'}</div>
          <div style={{ color: 'var(--muted)', fontSize: 10, textTransform: 'uppercase' }}>confidence</div>
        </div>
      </div>

      <div style={{ marginTop: 14, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 }}>
        <Metric label="Daily EMA9 bias" value={`${text(daily?.bias, 'neutral')} · ${text(daily?.reason)}`} />
        <Metric label="H1 EMA9 alignment" value={`${h1?.aligned === true ? 'aligned' : 'not aligned'} · ${text(h1?.reason)}`} />
        <Metric label="M5 tick volume" value={volumeRatio === null ? '—' : `${volumeRatio.toFixed(2)}x · threshold 1.50x`} />
        <Metric label="Manipulation" value={manipulationTypes.length ? manipulationTypes.join(', ').replaceAll('_', ' ') : 'waiting'} />
        <Metric label="Manipulation distance" value={distancePips === null ? '—' : `${distancePips.toFixed(1)} pips`} />
        <Metric label="Session" value={text(item?.session)} />
      </div>

      <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 8 }}>
        <Metric label="Entry" value={price(item?.entry ?? item?.entryPrice, item?.pair)} />
        <Metric label="Stop loss" value={price(item?.stopLoss, item?.pair)} />
        <Metric label="Take profit" value={price(item?.takeProfit, item?.pair)} />
        <Metric label="Risk / reward" value={rr === null ? '—' : `1 : ${rr.toFixed(2)}`} />
        <Metric label="Spread" value={num(item?.spreadPips) === null ? '—' : `${num(item?.spreadPips)?.toFixed(1)} pips`} />
      </div>

      <div style={{ marginTop: 10, padding: '10px 12px', border: '1px solid #1a5c38', background: '#0d2218', borderRadius: 8, fontSize: 12, lineHeight: 1.55 }}>
        <strong>Liquidity target:</strong>{' '}
        {price(target?.price ?? item?.takeProfit, item?.pair)}
        {targetSources.length ? ` · ${targetSources.join(', ')}` : ''}
        {num(target?.confluenceScore ?? confirmation?.targetConfluenceScore) !== null
          ? ` · confluence ${num(target?.confluenceScore ?? confirmation?.targetConfluenceScore)}`
          : ''}
      </div>

      {status === 'qualified' && <QualifiedExecuteButton engine="ppr" signal={item} />}

      <div style={{ marginTop: 10, color: '#ffcc66', fontSize: 12, lineHeight: 1.5 }}>
        Automated PPR scanning, entry, and management stop at 10:00 AM ET. After 10:00 AM ET, open PPR positions use broker-attached stop loss and take profit and are manual-management only.
      </div>
    </article>
  );
}

function IctCard({ item }: { item: any }) {
  const status = text(item?.status, 'rejected').toLowerCase();
  const rr = num(item?.rr);
  const legacyHtf = item?.concepts?.htf || {};
  const timeframeBias = item?.timeframeBias || {};
  const d1Bias = structureBias(timeframeBias?.d1 ?? legacyHtf?.dailyBias ?? item?.ictBias);
  const h4Bias = structureBias(timeframeBias?.h4 ?? legacyHtf?.h4Bias);
  const h1Bias = structureBias(timeframeBias?.h1 ?? legacyHtf?.h1Bias);
  const d1H4Aligned = timeframeBias?.d1H4Aligned === true || legacyHtf?.aligned === true;
  const displayedDirection = timeframeBias?.direction === 'buy' || timeframeBias?.direction === 'sell'
    ? timeframeBias.direction
    : item?.signal === 'buy' || item?.signal === 'sell'
      ? item.signal
      : d1H4Aligned && d1Bias === 'bullish'
        ? 'buy'
        : d1H4Aligned && d1Bias === 'bearish'
          ? 'sell'
          : 'none';
  return (
    <article style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 16, background: 'var(--panel)' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 18, fontFamily: "'JetBrains Mono', ui-monospace, monospace" }}>{pairLabel(item?.pair)}</strong>
        <DirectionBadge direction={displayedDirection} />
        <Badge status={status}>{status}</Badge>
      </div>
      <p style={{ margin: '10px 0 0', color: 'var(--muted)', fontSize: 12, lineHeight: 1.55 }}>{text(item?.ictNarrative || item?.reason)}</p>
      <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(145px, 1fr))', gap: 8 }}>
        <Metric label="D1 structure bias" value={biasLabel(d1Bias)} />
        <Metric label="H4 structure bias" value={biasLabel(h4Bias)} />
        <Metric label="H1 structure bias · analysis only" value={biasLabel(h1Bias)} />
      </div>
      <div style={{ marginTop: 8, color: 'var(--muted)', fontSize: 11, lineHeight: 1.45 }}>
        Trade direction is set only by aligned D1/H4 structure. H1 structure is analysis-only; the live H1 transition is used for entry timing.
      </div>
      <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 8 }}>
        <Metric label="Confidence" value={num(item?.confidence) === null ? '—' : `${num(item?.confidence)}%`} />
        <Metric label="Entry" value={price(item?.entry, item?.pair)} />
        <Metric label="Stop loss" value={price(item?.stopLoss, item?.pair)} />
        <Metric label="Target" value={price(item?.target1, item?.pair)} />
        <Metric label="Risk / reward" value={rr === null ? '—' : `1 : ${rr.toFixed(2)}`} />
      </div>
      {Array.isArray(item?.rejectionReasons) && item.rejectionReasons.length > 0 && (
        <div style={{ marginTop: 10, color: '#ff8888', fontSize: 12 }}>{item.rejectionReasons.join(' · ')}</div>
      )}
      {status === 'qualified' && <QualifiedExecuteButton engine="ict" signal={item} />}
    </article>
  );
}

export function NativeEngineScanPanel({ engine, qualified, watchCandidates, rejected }: Props) {
  const all = engine === 'ppr'
    ? [
        ...qualified.map((item) => ({ ...item, status: item?.status || 'qualified' })),
        ...watchCandidates,
        ...rejected,
      ]
    : [
        ...qualified.map((item) => ({ ...item, status: item?.status || 'qualified' })),
        ...rejected,
      ];

  return (
    <section style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 10, padding: 20 }}>
      <div style={{ marginBottom: 14 }}>
        <h3 style={{ margin: 0, fontSize: 16 }}>{engine === 'ppr' ? 'PPR — Price–Pool–Raid scan' : 'ICT native scan'}</h3>
        <p style={{ color: 'var(--muted)', margin: '5px 0 0', fontSize: 12, lineHeight: 1.5 }}>
          {engine === 'ppr'
            ? 'Native PPR output only: EMA9 bias, H1 alignment, liquidity pools, volume expansion, manipulation evidence, and executable geometry.'
            : 'Native ICT output only: liquidity, displacement, market structure shift, premium/discount, OTE, and killzone context.'}
        </p>
      </div>
      {all.length === 0 ? (
        <div style={{ border: '1px dashed var(--border)', borderRadius: 8, padding: 20, color: 'var(--muted)', textAlign: 'center', fontSize: 13 }}>
          No {engine.toUpperCase()} scan results were returned.
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          {all.map((item, index) => engine === 'ppr'
            ? <PprCard key={`${item?.pair || 'ppr'}_${item?.status || 'result'}_${index}`} item={item} />
            : <IctCard key={`${item?.pair || 'ict'}_${index}`} item={item} />)}
        </div>
      )}
    </section>
  );
}
