/**
 * web/components/ict-intelligence-panel.tsx
 *
 * ICT Intelligence dashboard panel. Fetches /api/ict/analyze and renders the
 * ICT-first analysis per pair: bias, killzone/macro timing, liquidity map,
 * FVG/OB, MSS/BOS/CHoCH, premium/discount + OTE, Power-of-3, Silver Bullet,
 * SMT, Turtle Soup, Judas Swing, IRL/ERL, the ICT recommendation (or rejection
 * reasons), and a V3-vs-ICT comparison.
 *
 * Read-only / shadow: nothing here can place or change a trade.
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import type { IctAnalysis, IctApiResponse, IctTradeApiResponse, IctTradeResult } from '@/types/ict';

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; analyses: IctAnalysis[]; mode: string; generatedAt: string; signals: number; executionEnabled: boolean; environment: string };

export function IctIntelligencePanel() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const res = await fetch('/api/ict/analyze', { cache: 'no-store' });
      const json: IctApiResponse = await res.json();
      if (!res.ok || !json?.ok || !json.ict) {
        setState({ kind: 'error', message: json?.error || `HTTP ${res.status}` });
        return;
      }
      setState({
        kind: 'ready',
        analyses: json.ict.analyses,
        mode: json.ict.meta.ictEngineMode,
        generatedAt: json.ict.meta.generatedAt,
        signals: json.ict.meta.signals,
        executionEnabled: json.ict.meta.executionEnabled === true,
        // Active environment from the proxy envelope. Reaching here means creds
        // are ready for that environment (the proxy 409s otherwise). Live is only
        // 'ready' when the platform flag + live-ack pass; paper needs neither.
        environment: typeof json.activeEnvironment === 'string' ? json.activeEnvironment : 'practice',
      });
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (state.kind === 'loading') {
    return <Shell><p style={{ color: 'var(--muted)', fontSize: 13 }}>Running ICT analysis…</p></Shell>;
  }
  if (state.kind === 'error') {
    return (
      <Shell>
        <p style={{ color: 'var(--bad)', fontSize: 13 }}>Could not load ICT analysis: {state.message}</p>
        <button onClick={() => void load()} style={btn}>Retry</button>
      </Shell>
    );
  }

  const isLive = state.environment === 'live';
  const isPaper = state.environment === 'practice' || state.environment === 'paper';
  // Execution is offered when the ICT engine is execution-enabled and the active
  // environment is usable. Paper/practice does NOT require the live-ack or the
  // platform flag; live does (already enforced upstream — reaching here means ok).
  const canExecute = state.executionEnabled && (isLive || isPaper);
  const executionLabel = state.executionEnabled ? (isPaper ? 'paper' : isLive ? 'live' : 'disabled') : 'disabled';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 800 }}>ICT Intelligence</h1>
          <p style={{ margin: '4px 0 0', color: 'var(--muted)', fontSize: 13 }}>
            ICT-first market read — liquidity, displacement, MSS/CHoCH, PD arrays, killzones. Manual execution only when enabled; never auto-trades.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Chip label="ICT engine" value={state.mode} tone={state.mode === 'live' ? 'good' : 'muted'} />
          <Chip
            label="Execution"
            value={executionLabel}
            tone={canExecute ? 'good' : 'muted'}
          />
          <Chip label="Signals" value={String(state.signals)} tone={state.signals > 0 ? 'good' : 'muted'} />
          <button onClick={() => void load()} style={btn}>Refresh</button>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {state.analyses.map((a) => (
          <IctCard key={a.pair} a={a} canExecute={canExecute} isPaper={isPaper} />
        ))}
      </div>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h1 style={{ margin: 0, fontSize: 20, fontWeight: 800 }}>ICT Intelligence</h1>
      {children}
    </div>
  );
}

const fmt = (n: number | null | undefined, dp = 5) => (n == null ? '—' : Number(n).toFixed(dp));
const dirColor = (d: string | null | undefined) =>
  d === 'bullish' || d === 'long' || d === 'buy' ? 'var(--good)'
  : d === 'bearish' || d === 'short' || d === 'sell' ? 'var(--bad)' : 'var(--muted)';

type TradeState =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'done'; result: IctTradeResult }
  | { kind: 'error'; message: string };

function IctCard({ a, canExecute, isPaper }: { a: IctAnalysis; canExecute: boolean; isPaper: boolean }) {
  const c = a.concepts;
  const dp = a.pair.includes('JPY') ? 3 : a.pair.startsWith('XA') ? 2 : 5;
  const signalTone = a.signal === 'buy' ? 'good' : a.signal === 'sell' ? 'bad' : 'muted';
  const [trade, setTrade] = useState<TradeState>({ kind: 'idle' });

  // Show the execute button ONLY for a live signal, when execution is enabled
  // and live trading is acknowledged (creds-ready is implied — the analyze call
  // 409s otherwise). The server re-validates everything before any order.
  const showExecute = a.signal !== 'none' && canExecute;

  const onExecute = async () => {
    const dir = a.signal === 'buy' ? 'long' : 'short';
    if (a.entry == null || a.stopLoss == null || a.target1 == null) {
      setTrade({ kind: 'error', message: 'Missing entry/stop/target on signal.' });
      return;
    }
    const ok = window.confirm(
      `Execute ${isPaper ? 'PAPER' : 'LIVE'} ICT ${dir.toUpperCase()} on ${a.pair}?\n` +
      `Entry ${a.entry} · Stop ${a.stopLoss} · Target ${a.target1} · RR ${a.rr ?? '?'}\n` +
      `Position is sized server-side from ICT_MAX_RISK_PERCENT.`,
    );
    if (!ok) return;
    setTrade({ kind: 'pending' });
    try {
      const res = await fetch('/api/ict/trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pair: a.pair, direction: dir, units: 0,
          entry: a.entry, stopLoss: a.stopLoss, targetProfit: a.target1,
          ictSignalId: a.signalId,
        }),
      });
      const json: IctTradeApiResponse = await res.json();
      if (!res.ok || !json.ok) { setTrade({ kind: 'error', message: json.error || `HTTP ${res.status}` }); return; }
      setTrade({ kind: 'done', result: json.ict ?? {} });
    } catch (err) {
      setTrade({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <section style={card}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
        <span style={{ fontFamily: 'var(--mono, monospace)', fontWeight: 800, fontSize: 18 }}>{a.pair}</span>
        <Chip label="Bias" value={a.ictBias} tone={a.ictBias === 'bullish' ? 'good' : a.ictBias === 'bearish' ? 'bad' : 'muted'} />
        <Chip label="Signal" value={a.signal.toUpperCase()} tone={signalTone} />
        {a.setupType && <Chip label="Setup" value={a.setupType} tone="info" />}
        {a.signal !== 'none' && <Chip label="Conf" value={`${a.confidence}%`} tone={a.confidence >= 70 ? 'good' : 'warn'} />}
        {c?.killzone?.inKillzone && <Chip label="Killzone" value={c.killzone.currentKillzone || ''} tone="info" />}
        {c?.macro?.activeMacro && <Chip label="Macro" value={c.macro.activeMacro} tone="info" />}
      </div>

      <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--text)' }}>{a.ictNarrative}</p>

      {/* Recommendation */}
      {a.signal !== 'none' && (
        <div style={recoBox}>
          <KV label="Entry" value={fmt(a.entry, dp)} color={dirColor(a.signal)} />
          <KV label="Stop" value={fmt(a.stopLoss, dp)} color="var(--bad)" />
          <KV label="Target 1" value={fmt(a.target1, dp)} color="var(--good)" />
          <KV label="Target 2" value={fmt(a.target2, dp)} color="var(--good)" />
          <KV label="R:R" value={a.rr != null ? `${a.rr}` : '—'} color={a.rr != null && a.rr >= 2 ? 'var(--good)' : 'var(--warn)'} />
          <KV label="Timing" value={a.timing.timingGrade} />
        </div>
      )}

      {/* Execute ICT Trade — only when a live signal exists, execution is enabled
          and live trading is acknowledged. Server re-validates before any order. */}
      {showExecute && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
          <button
            onClick={() => void onExecute()}
            disabled={trade.kind === 'pending'}
            style={{ ...btn, background: a.signal === 'buy' ? '#0d3320' : '#320d0d', color: a.signal === 'buy' ? 'var(--good)' : 'var(--bad)', border: '1px solid var(--border)', cursor: trade.kind === 'pending' ? 'wait' : 'pointer' }}
          >
            {trade.kind === 'pending'
              ? 'Submitting…'
              : isPaper
                ? `Execute Paper ICT ${a.signal === 'buy' ? 'BUY' : 'SELL'}`
                : `Execute ICT ${a.signal === 'buy' ? 'BUY' : 'SELL'}`}
          </button>
          {trade.kind === 'done' && (
            <span style={{ fontSize: 12, fontFamily: 'var(--mono, monospace)', color: trade.result.success ? 'var(--good)' : 'var(--warn)' }}>
              {trade.result.success
                ? `✓ Filled @ ${trade.result.fillPrice} (id ${trade.result.tradeId})`
                : `✗ ${trade.result.executionState ?? 'rejected'}: ${trade.result.reason ?? 'no fill'}`}
            </span>
          )}
          {trade.kind === 'error' && <span style={{ fontSize: 12, color: 'var(--bad)' }}>✗ {trade.message}</span>}
        </div>
      )}

      {/* Concept grid */}
      {c && (
        <div style={grid}>
          <KV label="Draw on Liquidity" value={c.dailyBias?.drawOnLiquidity ? `${c.dailyBias.drawOnLiquidity.side} · ${c.dailyBias.drawOnLiquidity.label}` : '—'} />
          <KV label="Swept Liquidity" value={c.liquidityMap?.sweptLiquidity ? `${c.liquidityMap.sweptLiquidity.label} (${c.liquidityMap.sweptLiquidity.direction})` : 'none'} color={c.liquidityMap?.sweptLiquidity ? dirColor(c.liquidityMap.sweptLiquidity.direction) : undefined} />
          <KV label="Active FVG" value={c.fvgs?.length ? `${c.fvgs[0].type} ${c.fvgs[0].status} (Q${c.fvgs[0].qualityScore})` : 'none'} color={c.fvgs?.length ? dirColor(c.fvgs[0].type) : undefined} />
          <KV label="Active OB" value={c.orderBlock?.type ? `${c.orderBlock.type} ${c.orderBlock.mitigated ? '(mitigated)' : 'fresh'} S${c.orderBlock.strengthScore}` : 'none'} color={c.orderBlock?.type ? dirColor(c.orderBlock.type) : undefined} />
          <KV label="Displacement" value={c.displacement?.direction ? `${c.displacement.direction} (${c.displacement.displacementScore})` : 'none'} color={dirColor(c.displacement?.direction)} />
          <KV label="MSS / BOS / CHoCH" value={[c.mss?.confirmed ? `MSS ${c.mss.direction}` : null, c.bos ? `BOS ${c.bos.direction}` : null, c.choch ? `CHoCH ${c.choch.direction}` : null].filter(Boolean).join(' · ') || 'none'} />
          <KV label="Premium / Discount" value={c.premiumDiscount?.currentZone || 'unknown'} color={c.premiumDiscount?.currentZone === 'discount' ? 'var(--good)' : c.premiumDiscount?.currentZone === 'premium' ? 'var(--warn)' : undefined} />
          <KV label="OTE" value={c.ote?.priceInOTE ? `in zone (Q${c.ote.oteQuality})` : `${fmt(c.ote?.oteLow, dp)}–${fmt(c.ote?.oteHigh, dp)}`} color={c.ote?.priceInOTE ? 'var(--good)' : undefined} />
          <KV label="Power of 3" value={c.powerOf3 ? `${c.powerOf3.phase}${c.powerOf3.manipulationSide ? ` · manip ${c.powerOf3.manipulationSide}` : ''}` : '—'} />
          <KV label="Silver Bullet" value={c.silverBullet?.activeWindow ? (a.signal !== 'none' ? `active · ${a.signal}` : 'window open') : 'inactive'} color={c.silverBullet?.activeWindow ? 'var(--good)' : undefined} />
          <KV label="SMT" value={c.smt?.smtDetected ? `${c.smt.direction} vs ${c.smt.comparisonAsset}` : (c.smt?.note || 'none')} color={c.smt?.smtDetected ? dirColor(c.smt.direction) : undefined} />
          <KV label="Turtle Soup" value={c.turtleSoup?.turtleSoupDetected ? `${c.turtleSoup.direction} (reclaimed)` : 'none'} color={c.turtleSoup?.turtleSoupDetected ? dirColor(c.turtleSoup.direction) : undefined} />
          <KV label="Judas Swing" value={c.judas?.judasSwingDetected ? `fake ${c.judas.fakeMoveDirection} → ${c.judas.trueMoveDirection}` : (c.judas?.asianRangeSwept ? 'range swept' : 'none')} />
          <KV label="IRL / ERL Draw" value={c.irlErl ? `${c.irlErl.currentDraw}${c.irlErl.nextTarget ? ` → ${c.irlErl.nextTarget.label}` : ''}` : '—'} />
          <KV label="Inducement" value={c.inducement?.inducementPresent ? (c.inducement.inducementSwept ? 'swept' : 'present (unswept)') : 'none'} color={c.inducement?.inducementPresent && !c.inducement.inducementSwept ? 'var(--warn)' : undefined} />
        </div>
      )}

      {/* Rejection reasons */}
      {a.rejectionReasons?.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--bad)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }}>Rejection reasons</div>
          <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--muted)', fontSize: 12, display: 'flex', flexDirection: 'column', gap: 2 }}>
            {a.rejectionReasons.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </div>
      )}

      {/* V3 vs ICT — DISPLAY ONLY (never used for ICT qualification/execution). */}
      {a.v3Comparison && (
        <div style={{ marginTop: 10, display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12, fontFamily: 'var(--mono, monospace)', borderTop: '1px solid var(--border)', paddingTop: 10, alignItems: 'baseline' }}>
          <span style={{ color: 'var(--muted)', fontWeight: 800 }}>V3 vs ICT:</span>
          <span>V3 <span style={{ color: dirColor(a.v3Comparison.v3Direction) }}>{a.v3Comparison.v3Direction ?? 'none'}</span> ({a.v3Comparison.v3Score}{a.v3Comparison.v3Qualified ? ', qualified' : ''})</span>
          <span>ICT <span style={{ color: dirColor(a.v3Comparison.ictDirection) }}>{a.v3Comparison.ictDirection ?? 'none'}</span></span>
          <span style={{ color: a.v3Comparison.agrees ? 'var(--good)' : 'var(--warn)' }}>{a.v3Comparison.agrees ? '✓ agree' : '≠ differ'}</span>
          <span style={{ color: 'var(--muted)', fontStyle: 'italic' }}>Display only — not used for ICT qualification or execution</span>
        </div>
      )}
    </section>
  );
}

type Tone = 'good' | 'bad' | 'warn' | 'info' | 'muted';
const toneColor: Record<Tone, string> = {
  good: 'var(--good)', bad: 'var(--bad)', warn: 'var(--warn)', info: '#4db8ff', muted: 'var(--muted)',
};

function Chip({ label, value, tone = 'muted' }: { label: string; value: string; tone?: Tone }) {
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'baseline', fontSize: 12, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--panel)' }}>
      <span style={{ color: 'var(--muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</span>
      <span style={{ color: toneColor[tone], fontWeight: 700 }}>{value}</span>
    </span>
  );
}

function KV({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: 700, color: color || 'var(--text)', fontFamily: 'var(--mono, monospace)' }}>{value}</span>
    </div>
  );
}

const card: React.CSSProperties = { background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 12, padding: 18 };
const recoBox: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 12,
  background: 'var(--bg, #08080f)', border: '1px solid var(--border)', borderRadius: 8, padding: '12px 14px', marginBottom: 12,
};
const grid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 };
const btn: React.CSSProperties = {
  background: 'var(--border)', color: 'var(--text)', border: '1px solid transparent', borderRadius: 6,
  padding: '6px 14px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
};
