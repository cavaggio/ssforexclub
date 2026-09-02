/**
 * src/components/ForexSignalStackTab.tsx
 * Full Forex Signal Stack UI tab — supports Forex + Metals (Gold/Silver).
 * All signals are backend-generated. No frontend signal logic.
 */

import { useState, useEffect, useCallback } from 'react';
import type {
  OandaDiagnostics,
  ForexScanResult,
  ForexSignal,
  ForexRejected,
  ForexTradeState,
  ForexTradeResult,
  ExecutionState,
  MacroAnalysis,
  StructureAnalysis,
  MomentumAnalysis,
  AlignmentResult,
  FibonacciAnalysis,
  InstitutionalFlow,
  ForexNewsRisk,
  EntryTiming,
  StopLossAnalysis,
} from '../types/forex.ts';
import {
  fetchDiagnostics,
  fetchScan,
  fetchTradeState,
  submitTrade,
  fetchActiveTrades,
} from '../lib/forexApi.ts';

// ─── Display helpers ──────────────────────────────────────────────────────────

function displayPair(pair: string): string {
  if (pair === 'XAU_USD') return 'Gold';
  if (pair === 'XAG_USD') return 'Silver';
  return pair.replace('_', '/');
}

function formatPrice(price: number, pair: string): string {
  if (pair === 'XAU_USD' || pair === 'XAG_USD') return price.toFixed(2);
  if (pair.includes('JPY')) return price.toFixed(3);
  return price.toFixed(5);
}

function formatUnits(units: number): string {
  return units.toLocaleString();
}

function formatAmount(amount: number): string {
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(2)}M`;
  if (amount >= 1_000) return `$${(amount / 1_000).toFixed(1)}K`;
  return `$${amount.toFixed(0)}`;
}

// ─── Badge component ──────────────────────────────────────────────────────────

type BadgeType = 'good' | 'warn' | 'bad' | 'neutral' | 'info' | 'metal';

function Badge({ value, type }: { value: string | number; type: BadgeType }) {
  const styles: Record<BadgeType, React.CSSProperties> = {
    good: { background: '#0d3320', color: '#2dff7a', border: '1px solid #1a5c38' },
    warn: { background: '#2d2200', color: '#ffcc00', border: '1px solid #5c4600' },
    bad: { background: '#320d0d', color: '#ff4d4d', border: '1px solid #5c1a1a' },
    neutral: { background: '#1a1a2e', color: '#8888aa', border: '1px solid #2a2a4a' },
    info: { background: '#0d1f32', color: '#4db8ff', border: '1px solid #1a4060' },
    metal: { background: '#2d1f00', color: '#ffaa00', border: '1px solid #5c4400' },
  };
  return (
    <span style={{
      ...styles[type],
      padding: '5px 12px',
      borderRadius: 6,
      fontSize: 14,
      fontWeight: 700,
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      whiteSpace: 'nowrap',
      letterSpacing: '0.3px',
      lineHeight: 1.3,
    }}>
      {value}
    </span>
  );
}

// ─── Score bar ────────────────────────────────────────────────────────────────

function ScoreBar({ score, max = 20, minScore = 8 }: { score: number; max?: number; minScore?: number }) {
  const pct = Math.round((score / max) * 100);
  const minPct = Math.round((minScore / max) * 100);
  const color = pct >= 60 ? '#2dff7a' : pct >= minPct ? '#ffcc00' : '#ff4d4d';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <div style={{ flex: 1, background: '#1a1a2e', borderRadius: 6, height: 12, overflow: 'hidden', position: 'relative' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 6, transition: 'width 0.4s ease' }} />
      </div>
      <span style={{ fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontSize: 18, fontWeight: 700, color, minWidth: 64, textAlign: 'right' }}>
        {score}/{max}
      </span>
    </div>
  );
}

// ─── Diagnostics panel ────────────────────────────────────────────────────────

function DiagnosticsPanel({ diag }: { diag: OandaDiagnostics | null }) {
  if (!diag) return (
    <div style={s.panel}>
      <span style={{ color: '#888', fontSize: 15 }}>Loading diagnostics…</span>
    </div>
  );

  return (
    <div style={s.panel}>
      <div style={s.diagGrid}>
        <DiagRow label="OANDA ENV" value={diag.env.toUpperCase()} type={diag.env === 'live' ? 'warn' : 'info'} />
        <DiagRow label="API Key" value={diag.apiKeySet ? '✓ Set' : '✗ Missing'} type={diag.apiKeySet ? 'good' : 'bad'} />
        <DiagRow label="Account ID" value={diag.accountIdSet ? '✓ Set' : '✗ Missing'} type={diag.accountIdSet ? 'good' : 'bad'} />
        <DiagRow label="Connection" value={diag.connectionOk ? '✓ OK' : '✗ Failed'} type={diag.connectionOk ? 'good' : 'bad'} />
        <DiagRow label="Account" value={diag.accountReachable ? '✓ Reachable' : '✗ Unreachable'} type={diag.accountReachable ? 'good' : 'bad'} />
        {diag.accountBalance !== null && (
          <DiagRow label="Balance" value={`${diag.accountCurrency} ${diag.accountBalance.toFixed(2)}`} type="info" />
        )}
      </div>
      {diag.error && <div style={s.errorBox}>⚠ {diag.error}</div>}
      {diag.connectionOk && diag.accountReachable && (
        <div style={{ marginTop: 12, color: '#2dff7a', fontSize: 14, fontWeight: 600 }}>✓ All systems operational</div>
      )}
    </div>
  );
}

function DiagRow({ label, value, type }: { label: string; value: string; type: BadgeType }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', gap: 12 }}>
      <span style={{ color: '#aaa', fontSize: 15, fontWeight: 500, letterSpacing: '0.2px' }}>{label}</span>
      <Badge value={value} type={type} />
    </div>
  );
}

function TradeStatePanel({ state }: { state: ForexTradeState | null }) {
  if (!state) return null;
  const cooldownSec = Math.ceil(state.cooldownRemainingMs / 1000);
  return (
    <div style={s.panel}>
      <div style={s.diagGrid}>
        <DiagRow
          label="Auto-Trade"
          value={state.autoTradeEnabled ? '✓ ENABLED' : '✗ DISABLED'}
          type={state.autoTradeEnabled ? 'warn' : 'neutral'}
        />
        <DiagRow
          label="Daily Trades"
          value={`${state.dailyTradesCount} / ${state.dailyTradesCap}`}
          type={state.dailyTradesCount >= state.dailyTradesCap ? 'bad' : 'good'}
        />
        <DiagRow
          label="Daily Loss"
          value={`$${state.dailyLossUSD.toFixed(2)}`}
          type={state.dailyLossUSD > 0 ? 'warn' : 'good'}
        />
        {cooldownSec > 0 && (
          <DiagRow label="Cooldown" value={`${cooldownSec}s remaining`} type="warn" />
        )}
      </div>
      {!state.autoTradeEnabled && (
        <div style={{ marginTop: 12, color: '#888', fontSize: 13, lineHeight: 1.55 }}>
          Set FOREX_AUTO_TRADE_ENABLED=true in .env to enable live execution.
        </div>
      )}
    </div>
  );
}

// ─── Multi-timeframe Waterfall Panel ──────────────────────────────────────────

function trendColor(t: string): string {
  if (t === 'bullish' || t === 'aligned_bullish') return '#2dff7a';
  if (t === 'bearish' || t === 'aligned_bearish') return '#ff4d4d';
  return '#888';
}

function biasLabel(t: string): string {
  if (t === 'bullish') return '▲ Bullish';
  if (t === 'bearish') return '▼ Bearish';
  if (t === 'ranging') return '◆ Ranging';
  return '· Neutral';
}

function TimeframePill({ tf, trend }: { tf: string; trend: string }) {
  const color = trendColor(trend);
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
      padding: '10px 14px', borderRadius: 8,
      background: '#08080f', border: `1px solid ${color}55`,
      minWidth: 84,
    }}>
      <span style={{
        fontSize: 12, color: '#888', letterSpacing: '0.8px',
        textTransform: 'uppercase', fontWeight: 600,
      }}>{tf}</span>
      <span style={{
        fontFamily: "'JetBrains Mono', ui-monospace, monospace",
        fontSize: 15, fontWeight: 700, color, lineHeight: 1.2,
      }}>
        {trend === 'bullish' ? '▲' : trend === 'bearish' ? '▼' : '·'} {trend === 'neutral' ? 'flat' : trend}
      </span>
    </div>
  );
}

function MiniBar({ value, max = 100, color = '#4db8ff' }: { value: number; max?: number; color?: string }) {
  const pct = Math.max(0, Math.min(100, Math.round((value / max) * 100)));
  return (
    <div style={{ background: '#1a1a2e', borderRadius: 5, height: 10, overflow: 'hidden' }}>
      <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 5, transition: 'width 0.4s ease' }} />
    </div>
  );
}

function WaterfallPanel({
  macro, structure, momentum, alignment, direction,
}: {
  macro: MacroAnalysis;
  structure: StructureAnalysis;
  momentum: MomentumAnalysis;
  alignment: AlignmentResult;
  direction: 'long' | 'short' | 'neutral';
}) {
  const macroColor =
    macro.macroBias === 'bullish' ? '#2dff7a' :
    macro.macroBias === 'bearish' ? '#ff4d4d' : '#ffcc00';
  const alignColor =
    alignment.alignmentStatus === 'strong' ? '#2dff7a' :
    alignment.alignmentStatus === 'mixed'  ? '#ffcc00' : '#ff4d4d';
  const revColor =
    structure.reversalRisk === 'low'    ? '#2dff7a' :
    structure.reversalRisk === 'medium' ? '#ffcc00' : '#ff4d4d';

  return (
    <div style={wfStyles.container}>

      {/* Timeframe pill row */}
      <div style={wfStyles.timeframeRow}>
        <TimeframePill tf="Daily" trend={alignment.timeframes.daily} />
        <TimeframePill tf="H4"    trend={alignment.timeframes.h4} />
        <TimeframePill tf="H1"    trend={alignment.timeframes.h1} />
        <TimeframePill tf="M30"   trend={alignment.timeframes.m30} />
        <TimeframePill tf="M15"   trend={alignment.timeframes.m15} />
        <TimeframePill tf="M5"    trend={alignment.timeframes.m5} />
      </div>

      {/* Layer 1 — Macro */}
      <div style={wfStyles.layerRow}>
        <div style={wfStyles.layerLabel}>L1 Macro</div>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 16, color: macroColor, fontWeight: 800 }}>
              {biasLabel(macro.macroBias)}
            </span>
            <span style={{ fontSize: 14, color: '#888', lineHeight: 1.5 }}>
              · Daily {macro.dailyTrend} · H4 {macro.h4Trend} · regime {macro.volatilityRegime}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 14, marginTop: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 13, color: '#aaa', minWidth: 84, fontWeight: 500 }}>conf {macro.macroConfidence}</span>
            <div style={{ flex: 1 }}><MiniBar value={macro.macroConfidence} color={macroColor} /></div>
            <span style={{ fontSize: 13, color: '#aaa', fontWeight: 500 }}>str {macro.trendStrength}</span>
          </div>
        </div>
      </div>

      {/* Layer 2 — Structure */}
      <div style={wfStyles.layerRow}>
        <div style={wfStyles.layerLabel}>L2 Structure</div>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{
              fontFamily: "'JetBrains Mono', monospace", fontSize: 16, fontWeight: 800,
              color: structure.structureAligned ? '#2dff7a' : '#ffcc00',
            }}>
              {structure.structureAligned ? '✓ Aligned' : '✗ Misaligned'}
            </span>
            {structure.pullbackDetected && (
              <Badge value="Pullback" type="info" />
            )}
            <Badge
              value={`reversal ${structure.reversalRisk}`}
              type={structure.reversalRisk === 'low' ? 'good' : structure.reversalRisk === 'medium' ? 'warn' : 'bad'}
            />
            <span style={{ fontSize: 14, color: '#888' }}>
              · H1 {structure.h1Trend} · M30 {structure.m30Trend}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 14, marginTop: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 13, color: '#aaa', minWidth: 84, fontWeight: 500 }}>conf {structure.structuralConfidence}</span>
            <div style={{ flex: 1 }}><MiniBar value={structure.structuralConfidence} color={revColor} /></div>
            <span style={{ fontSize: 13, color: '#aaa', fontWeight: 500 }}>cont {structure.continuationProbability}%</span>
          </div>
          {structure.nearKeyLevel && (
            <div style={{ marginTop: 8, fontSize: 13, color: '#ffaa00', fontWeight: 600 }}>
              ⚠ {structure.nearKeyLevel.distancePips}p to H4 {structure.nearKeyLevel.kind} @ {structure.nearKeyLevel.price}
            </div>
          )}
        </div>
      </div>

      {/* Layer 3 — Momentum / Execution */}
      <div style={wfStyles.layerRow}>
        <div style={wfStyles.layerLabel}>L3 Momentum</div>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{
              fontFamily: "'JetBrains Mono', monospace", fontSize: 16, fontWeight: 800,
              color: momentum.executionSignal ? trendColor(momentum.executionSignal === 'long' ? 'bullish' : 'bearish') : '#888',
            }}>
              trigger {momentum.executionSignal ? momentum.executionSignal.toUpperCase() : 'NONE'}
            </span>
            <span style={{ fontSize: 14, color: '#888' }}>
              · M15 {momentum.m15Trend} · M5 {momentum.m5Trend} · candle {momentum.candleConfirmation}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 14, marginTop: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 13, color: '#aaa', minWidth: 84, fontWeight: 500 }}>conf {momentum.executionConfidence}</span>
            <div style={{ flex: 1 }}>
              <MiniBar value={momentum.executionConfidence} color={direction === 'long' ? '#2dff7a' : '#ff4d4d'} />
            </div>
            <span style={{ fontSize: 13, color: '#aaa', fontWeight: 500 }}>
              mom {momentum.momentumStrength} · entry {momentum.entryQuality} · time {momentum.timingScore}
            </span>
          </div>
        </div>
      </div>

      {/* Alignment summary */}
      <div style={{
        ...wfStyles.layerRow,
        background: '#0a0a14',
        border: `1px solid ${alignColor}55`,
        borderRadius: 10,
        padding: '14px 16px',
        marginTop: 4,
      }}>
        <div style={wfStyles.layerLabel}>Alignment</div>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{
              fontFamily: "'JetBrains Mono', monospace", fontSize: 28, color: alignColor,
              fontWeight: 800, letterSpacing: '-0.5px', lineHeight: 1.1,
            }}>
              {alignment.timeframeAlignmentScore}/100
            </span>
            <Badge
              value={alignment.alignmentStatus.toUpperCase()}
              type={alignment.alignmentStatus === 'strong' ? 'good' : alignment.alignmentStatus === 'mixed' ? 'warn' : 'bad'}
            />
            <Badge value={`bias ${alignment.dominantBias}`} type="info" />
            {alignment.conflictingTimeframes.length > 0 && (
              <span style={{ fontSize: 14, color: '#ff8c00', fontFamily: "'JetBrains Mono', monospace", fontWeight: 600 }}>
                ⚠ conflicts: {alignment.conflictingTimeframes.join(', ')}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Entry Quality Panel ──────────────────────────────────────────────────────
// Compact 5-row section showing the new entry-quality layer: Fib zone,
// institutional flow, news risk, entry-timing status, and SL structure.

function statusColor(status: string): string {
  switch (status) {
    case 'valid_entry':
    case 'inside_zone':
    case 'breakout_confirmed':
    case 'bullish':
      return '#2dff7a';
    case 'too_early':
    case 'wait_for_retest':
    case 'medium':
    case 'mixed':
      return '#ffcc00';
    case 'late_entry':
    case 'news_blocked':
    case 'extended':
    case 'invalidated':
    case 'high':
    case 'bearish':
      return '#ff4d4d';
    case 'unknown':
    case 'low':
    case 'neutral':
    default:
      return '#888';
  }
}

function EntryQualityRow({
  label, value, valueColor, sub,
}: {
  label: string;
  value: string;
  valueColor: string;
  sub?: string | null;
}) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'flex-start',
      gap: 12,
      padding: '8px 6px',
      borderTop: '1px solid #15152a',
    }}>
      <div style={{
        minWidth: 116,
        fontSize: 13,
        color: '#888',
        fontFamily: "'JetBrains Mono', monospace",
        fontWeight: 700,
        letterSpacing: '0.6px',
        textTransform: 'uppercase',
        paddingTop: 2,
      }}>{label}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 0 }}>
        <span style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 14,
          fontWeight: 700,
          color: valueColor,
          letterSpacing: '0.2px',
        }}>{value}</span>
        {sub ? (
          <span style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 12, color: '#888', lineHeight: 1.45,
          }}>{sub}</span>
        ) : null}
      </div>
    </div>
  );
}

function EntryQualityPanel({
  fibonacci, institutionalFlow, newsRisk, entryTiming, stopLossAnalysis,
}: {
  fibonacci?: FibonacciAnalysis;
  institutionalFlow?: InstitutionalFlow;
  newsRisk?: ForexNewsRisk;
  entryTiming?: EntryTiming;
  stopLossAnalysis?: StopLossAnalysis;
}) {
  // If we have none of the new fields, render nothing — keeps cards from
  // showing an empty section while the backend is still warming up.
  if (!fibonacci && !institutionalFlow && !newsRisk && !entryTiming && !stopLossAnalysis) {
    return null;
  }

  const timingStatus = entryTiming?.status ?? 'unknown';
  const fibStatus = fibonacci?.entryZoneStatus ?? 'unknown';
  const flowDir   = institutionalFlow?.direction ?? 'neutral';
  const newsLvl   = newsRisk?.riskLevel ?? 'low';

  const fibValue = fibonacci?.timeframeUsed
    ? `${fibStatus.replace(/_/g, ' ')} · ${fibonacci.timeframeUsed} impulse ${fibonacci.impulsePips ?? '—'}p` +
      (fibonacci.pctRetraced != null ? ` · ${(fibonacci.pctRetraced * 100).toFixed(0)}% retraced` : '')
    : fibStatus.replace(/_/g, ' ');

  const flowValue = institutionalFlow?.detected
    ? `${institutionalFlow.type.replace(/_/g, ' ')} · ${flowDir}` +
      (institutionalFlow.confidenceImpact ? ` · ${institutionalFlow.confidenceImpact >= 0 ? '+' : ''}${institutionalFlow.confidenceImpact} conf` : '')
    : 'none detected';

  const newsValue = newsRisk
    ? `${newsLvl}${newsRisk.blocked ? ' · BLOCKED' : ''}${newsRisk.postNewsConfirmationRequired ? ' · post-news confirm' : ''}` +
      (newsRisk.matchingCurrencies?.length ? ` · ${newsRisk.matchingCurrencies.join('+')}` : '')
    : 'low';

  const slValue = stopLossAnalysis
    ? `${(stopLossAnalysis.structureSource ?? 'unknown').replace(/_/g, ' ')} · buf ${stopLossAnalysis.atrBuffer}p · @ ${stopLossAnalysis.finalStopLoss}`
    : '—';

  return (
    <div style={{
      background: '#0a0a14',
      border: '1px solid #181830',
      borderRadius: 10,
      padding: '6px 16px 12px 16px',
      marginBottom: 16,
    }}>
      <div style={{
        fontSize: 12, color: '#888',
        fontFamily: "'JetBrains Mono', monospace",
        fontWeight: 700, letterSpacing: '1px',
        textTransform: 'uppercase',
        padding: '12px 6px 6px 6px',
      }}>
        Entry Quality
      </div>

      <EntryQualityRow
        label="Entry Timing"
        value={timingStatus.replace(/_/g, ' ').toUpperCase()}
        valueColor={statusColor(timingStatus)}
        sub={entryTiming?.reason}
      />
      <EntryQualityRow
        label="Fib Zone"
        value={fibValue.toUpperCase()}
        valueColor={statusColor(fibStatus)}
        sub={fibonacci?.reason}
      />
      <EntryQualityRow
        label="Institutional Flow"
        value={flowValue.toUpperCase()}
        valueColor={statusColor(flowDir)}
        sub={institutionalFlow?.reason}
      />
      <EntryQualityRow
        label="News Risk"
        value={newsValue.toUpperCase()}
        valueColor={statusColor(newsLvl)}
        sub={newsRisk?.reason}
      />
      <EntryQualityRow
        label="SL Structure"
        value={slValue.toUpperCase()}
        valueColor={
          stopLossAnalysis?.structureSource === 'h1_swing' ||
          stopLossAnalysis?.structureSource === 'liquidity_sweep' ||
          stopLossAnalysis?.structureSource === 'fib_impulse_origin'
            ? '#2dff7a'
            : stopLossAnalysis?.structureSource === 'atr_fallback'
              ? '#ff8c00'
              : '#ffcc00'
        }
        sub={stopLossAnalysis?.reason}
      />
    </div>
  );
}

const wfStyles: Record<string, React.CSSProperties> = {
  container: {
    background: '#0a0a14',
    border: '1px solid #181830',
    borderRadius: 10,
    padding: 16,
    marginBottom: 16,
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  timeframeRow: {
    display: 'flex',
    gap: 10,
    justifyContent: 'space-between',
    marginBottom: 8,
    flexWrap: 'wrap',
  },
  layerRow: {
    display: 'flex',
    gap: 16,
    alignItems: 'flex-start',
    padding: '8px 6px',
  },
  layerLabel: {
    fontSize: 13,
    color: '#888',
    fontFamily: "'JetBrains Mono', monospace",
    fontWeight: 700,
    letterSpacing: '0.6px',
    minWidth: 116,
    textTransform: 'uppercase',
    paddingTop: 2,
  },
};

// ─── Qualified Signal Card ────────────────────────────────────────────────────

function SignalCard({ signal, onTrade, tradeResult }: {
  signal: ForexSignal;
  onTrade: (s: ForexSignal) => void;
  tradeResult: ForexTradeResult | null;
}) {
  const isLong = signal.direction === 'long';
  const isMetal = signal.assetClass === 'Metal';
  const dirColor = isLong ? '#2dff7a' : '#ff4d4d';
  const confColor = signal.confidence >= 60 ? '#2dff7a' : signal.confidence >= 30 ? '#ffcc00' : '#ff8c00';
  const pairDisplay = displayPair(signal.pair);

  return (
    <div style={{ ...s.card, borderColor: isMetal ? '#3d2a00' : '#1e1e30' }}>

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 18, gap: 16 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
            <span style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontWeight: 800, fontSize: 26,
              color: isMetal ? '#ffaa00' : '#e0e0ff',
              letterSpacing: '-0.3px',
            }}>
              {pairDisplay}
            </span>
            <Badge value={isLong ? 'BUY' : 'SELL'} type={isLong ? 'good' : 'bad'} />
            <Badge value={isLong ? 'LONG' : 'SHORT'} type={isLong ? 'good' : 'bad'} />
            <Badge value={signal.assetClass} type={isMetal ? 'metal' : 'neutral'} />
          </div>
          <div style={{ fontSize: 14, color: '#888', fontFamily: "'JetBrains Mono', monospace" }}>
            {signal.instrumentName}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 32, color: confColor, fontWeight: 800,
            lineHeight: 1.1, letterSpacing: '-0.5px',
          }}>
            {signal.confidence}%
          </div>
          <div style={{
            fontSize: 12, color: '#888', marginTop: 4,
            textTransform: 'uppercase', letterSpacing: '1px', fontWeight: 600,
          }}>
            confidence
          </div>
        </div>
      </div>

      {/* ── Session + Trade Duration ───────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <Badge value={signal.session} type="info" />
        <Badge
          value={signal.tradeDuration}
          type={signal.tradeDuration === 'Intraday' ? 'good' : signal.tradeDuration === 'Scalp' ? 'warn' : 'neutral'}
        />
      </div>

      {/* ── Multi-timeframe Waterfall ──────────────────────────────────── */}
      {signal.macro && signal.structure && signal.momentum && signal.alignment && (
        <WaterfallPanel
          macro={signal.macro}
          structure={signal.structure}
          momentum={signal.momentum}
          alignment={signal.alignment}
          direction={signal.direction}
        />
      )}

      {/* ── Entry Quality (fib / flow / news / timing / SL structure) ──── */}
      <EntryQualityPanel
        fibonacci={signal.fibonacci}
        institutionalFlow={signal.institutionalFlow}
        newsRisk={signal.newsRisk}
        entryTiming={signal.entryTiming}
        stopLossAnalysis={signal.stopLossAnalysis}
      />

      {/* ── Intraday Intel ─────────────────────────────────────────────── */}
      <div style={s.intradayGrid}>
        <IntradayCell
          label="Hold Time"
          value={`~${signal.estimatedHoldMinutes}m`}
          color={signal.tradeDuration === 'Intraday' ? '#2dff7a' : signal.tradeDuration === 'Scalp' ? '#ffcc00' : '#888'}
        />
        <IntradayCell
          label="Volatility"
          value={signal.volatilityState}
          color={signal.volatilityState === 'expanding' ? '#2dff7a' : signal.volatilityState === 'normal' ? '#ffcc00' : '#ff4d4d'}
        />
        <IntradayCell
          label="Trend Str"
          value={`${signal.trendStrength}%`}
          color={signal.trendStrength >= 75 ? '#2dff7a' : signal.trendStrength >= 50 ? '#ffcc00' : '#888'}
        />
        <IntradayCell
          label="Momentum"
          value={`${signal.momentumScore}%`}
          color={signal.momentumScore >= 75 ? '#2dff7a' : signal.momentumScore >= 50 ? '#ffcc00' : '#888'}
        />
        {signal.expectedMovementPips !== null && (
          <IntradayCell label="Exp Move" value={`${signal.expectedMovementPips}p`} color="#4db8ff" />
        )}
      </div>

      {/* ── Price levels (fixed 10p / 15p / 1.5R) ───────────────────────── */}
      <div style={s.priceGrid}>
        <PriceCell
          label="Entry"
          value={formatPrice(signal.entry, signal.pair)}
          color="#e0e0ff"
        />
        <PriceCell
          label="Stop Loss"
          value={formatPrice(signal.stopLoss, signal.pair)}
          color="#ff4d4d"
          sub={`${signal.stopLossPips} pips`}
        />
        <PriceCell
          label="Take Profit"
          value={formatPrice(signal.takeProfit, signal.pair)}
          color="#2dff7a"
          sub={`${(signal.takeProfitPips ?? signal.stopLossPips * signal.riskReward).toFixed(0)} pips`}
        />
        <PriceCell
          label="Risk / Reward"
          value={`1 : ${signal.riskReward}`}
          color={signal.riskReward >= 3 ? '#2dff7a' : '#ffcc00'}
        />
      </div>

      {/* ── Per-trade risk block ─────────────────────────────────────────
          All values are calculated server-side per signal from live account
          balance + this signal's confidence, score, spread, and volatility.
          No hardcoded defaults — empty fields mean the backend did not produce
          a value, and that's surfaced rather than masked with a fake number. */}
      {(signal.targetRiskUSD !== undefined ||
        signal.actualRiskUSD !== undefined ||
        signal.estimatedRewardUSD !== undefined ||
        signal.estimatedMarginRequired !== undefined ||
        signal.effectiveLeverage !== undefined) && (
        <div style={s.riskGrid}>
          <SizingCell
            label="Risk %"
            value={signal.riskPercent !== undefined ? `${signal.riskPercent.toFixed(2)}%` : '—'}
          />
          <SizingCell
            label="Target Risk"
            value={signal.targetRiskUSD !== undefined ? `$${signal.targetRiskUSD.toFixed(2)}` : '—'}
          />
          <SizingCell
            label="Actual Risk"
            value={signal.actualRiskUSD !== undefined ? `$${signal.actualRiskUSD.toFixed(2)}` : '—'}
          />
          <SizingCell
            label="Est. Reward"
            value={signal.estimatedRewardUSD !== undefined ? `$${signal.estimatedRewardUSD.toFixed(2)}` : '—'}
          />
          <SizingCell
            label="Est. Margin"
            value={signal.estimatedMarginRequired !== undefined ? `$${signal.estimatedMarginRequired.toFixed(2)}` : '—'}
          />
          <SizingCell
            label="Leverage"
            value={signal.effectiveLeverage !== undefined ? `${signal.effectiveLeverage.toFixed(0)}:1` : '—'}
          />
        </div>
      )}

      {/* ── Position sizing ────────────────────────────────────────────── */}
      <div style={s.sizingGrid}>
        <SizingCell label="Lot Size" value={signal.lotSize.toFixed(4)} />
        <SizingCell label="Units" value={formatUnits(signal.tradeUnits)} />
        <SizingCell label="Notional" value={formatAmount(signal.amountTraded)} />
        <SizingCell label="R:R" value={`1 : ${signal.riskReward.toFixed(2)}`} />
        <SizingCell label="Spread" value={`${signal.spreadPips.toFixed(1)} pip`} />
      </div>

      {/* ── Dynamic targeting reasoning ────────────────────────────────── */}
      {signal.lifecycle && (
        <div style={s.sizingFactorsBox}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div>
              <span style={{ color: '#888' }}>Target reason:</span>{' '}
              <span style={{ color: '#2dff7a' }}>{signal.targetReason}</span>
            </div>
            <div>
              <span style={{ color: '#888' }}>Invalidation:</span>{' '}
              <span style={{ color: '#ff8c00' }}>{signal.invalidationReason}</span>
            </div>
            <div>
              <span style={{ color: '#888' }}>Hold window:</span>{' '}
              <span style={{ color: '#4db8ff', fontWeight: 700 }}>
                {signal.holdWindowMinMinutes}–{signal.holdWindowMaxMinutes} min
              </span>{' '}
              <span style={{ color: '#666' }}>(conf {signal.holdConfidence})</span>
              {' · '}
              <span style={{ color: '#888' }}>TP prob:</span>{' '}
              <span style={{ color: '#2dff7a', fontWeight: 700 }}>{((signal.tpProbability ?? 0) * 100).toFixed(0)}%</span>
              {' · '}
              <span style={{ color: '#888' }}>SL prob:</span>{' '}
              <span style={{ color: '#ff6666', fontWeight: 700 }}>{((signal.slProbability ?? 0) * 100).toFixed(0)}%</span>
              {signal.cappedByKeyLevel && (
                <span style={{ marginLeft: 8, color: '#ffaa00' }}>
                  ⚠ TP capped by H4 key level @ {signal.keyLevelDistance}p
                </span>
              )}
              {signal.cappedByAtr && (
                <span style={{ marginLeft: 8, color: '#ffaa00' }}>⚠ TP capped by ATR realism</span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Sizing factors (why this trade is sized this way) ──────────── */}
      {signal.riskSizingFactors && signal.riskSizingFactors.modifiers && signal.riskSizingFactors.modifiers.length > 0 && (
        <div style={s.sizingFactorsBox}>
          <span style={{ color: '#888' }}>Sizing modifiers:</span>{' '}
          <span style={{ color: '#4db8ff' }}>{signal.riskSizingFactors.modifiers.join(' · ')}</span>
        </div>
      )}

      {/* ── Sizing warnings ─────────────────────────────────────────────── */}
      {signal.sizingWarnings && signal.sizingWarnings.length > 0 && (
        <div style={s.sizingWarnBox}>
          {signal.sizingWarnings.map((w, i) => (
            <div key={i}>⚠ {w}</div>
          ))}
        </div>
      )}

      {/* ── Alignment Score ─────────────────────────────────────────────── */}
      <div style={{ marginBottom: 18 }}>
        <div style={{
          fontSize: 13, color: '#888', marginBottom: 8,
          textTransform: 'uppercase', letterSpacing: '0.8px', fontWeight: 600,
        }}>Timeframe Alignment Score</div>
        <ScoreBar score={signal.score} max={100} minScore={55} />
      </div>

      {/* ── Indicators row ─────────────────────────────────────────────── */}
      <div style={s.indicatorRow}>
        {signal.rsi !== null && (
          <IndCell label="RSI" value={signal.rsi.toFixed(1)}
            color={signal.rsi > 70 ? '#ff4d4d' : signal.rsi < 30 ? '#4db8ff' : '#e0e0ff'} />
        )}
        {signal.macd && (
          <IndCell label="MACD"
            value={`${signal.macd.histogram > 0 ? '▲' : '▼'} ${Math.abs(signal.macd.histogram).toFixed(5)}`}
            color={signal.macd.histogram > 0 ? '#2dff7a' : '#ff4d4d'} />
        )}
        {signal.atrPips !== null && (
          <IndCell label="ATR" value={`${signal.atrPips.toFixed(1)}p`} color="#e0e0ff" />
        )}
        <IndCell label="Trend" value={signal.trend}
          color={signal.trend === 'bullish' ? '#2dff7a' : signal.trend === 'bearish' ? '#ff4d4d' : '#888'} />
        <IndCell label="Candle" value={signal.candleConfirmation}
          color={signal.candleConfirmation === 'bullish' ? '#2dff7a' : signal.candleConfirmation === 'bearish' ? '#ff4d4d' : '#888'} />
      </div>

      {/* ── Score breakdown (collapsible) ───────────────────────────────── */}
      <details style={{ marginTop: 14 }}>
        <summary style={{
          cursor: 'pointer', color: '#888', fontSize: 14, userSelect: 'none',
          padding: '4px 0', fontWeight: 600,
        }}>Score breakdown</summary>
        <div style={s.breakdownGrid}>
          {Object.entries(signal.scoreBreakdown).map(([key, val]) => (
            <div key={key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0' }}>
              <span style={{ color: '#aaa', fontSize: 14, textTransform: 'capitalize', fontWeight: 500 }}>
                {key.replace(/([A-Z])/g, ' $1').trim()}
              </span>
              <Badge value={`${val}/2`} type={val === 2 ? 'good' : val === 1 ? 'warn' : 'neutral'} />
            </div>
          ))}
        </div>
      </details>

      {/* ── Trade button + timestamp ────────────────────────────────────── */}
      <div style={{ marginTop: 20, display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <button
          onClick={() => onTrade(signal)}
          style={s.tradeBtn}
          onMouseEnter={e => (e.currentTarget.style.opacity = '0.85')}
          onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
        >
          Execute Trade
        </button>
        <span style={{ fontSize: 13, color: '#666', fontFamily: "'JetBrains Mono', monospace" }}>
          {new Date(signal.generatedAt).toLocaleTimeString()}
        </span>
      </div>

      {/* ── Execution result panel ──────────────────────────────────────── */}
      {tradeResult && <ExecutionPanel result={tradeResult} />}
    </div>
  );
}

function PriceCell({ label, value, color, sub }: { label: string; value: string; color: string; sub?: string }) {
  return (
    <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{
        fontSize: 12, color: '#888',
        textTransform: 'uppercase', letterSpacing: '0.8px', fontWeight: 600,
      }}>{label}</div>
      <div style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 22, fontWeight: 700, color, lineHeight: 1.2, letterSpacing: '-0.3px',
      }}>{value}</div>
      {sub && (
        <div style={{ fontSize: 12, color: '#888', marginTop: 2, fontWeight: 500 }}>{sub}</div>
      )}
    </div>
  );
}

function SizingCell({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{
        fontSize: 12, color: '#888',
        textTransform: 'uppercase', letterSpacing: '0.7px', fontWeight: 600,
      }}>{label}</div>
      <div style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 18, color: '#e0e0ff', fontWeight: 700, lineHeight: 1.2,
      }}>{value}</div>
    </div>
  );
}

function IndCell({ label, value, color = '#e0e0ff' }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{
        fontSize: 12, color: '#888',
        textTransform: 'uppercase', letterSpacing: '0.7px', fontWeight: 600,
      }}>{label}</span>
      <span style={{
        fontSize: 16, fontFamily: "'JetBrains Mono', monospace",
        fontWeight: 700, color, lineHeight: 1.2,
      }}>{value}</span>
    </div>
  );
}

function IntradayCell({ label, value, color = '#e0e0ff' }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, textAlign: 'center' }}>
      <span style={{
        fontSize: 12, color: '#888',
        textTransform: 'uppercase', letterSpacing: '0.6px', fontWeight: 600,
      }}>{label}</span>
      <span style={{
        fontSize: 16, fontFamily: "'JetBrains Mono', monospace",
        fontWeight: 700, color, lineHeight: 1.2,
      }}>{value}</span>
    </div>
  );
}

// ─── Execution panel ──────────────────────────────────────────────────────────

const STATE_STYLE: Record<ExecutionState, { bg: string; border: string; color: string; label: string }> = {
  SUBMITTED:   { bg: '#0d1f32', border: '#1a4060', color: '#4db8ff', label: 'SUBMITTED' },
  FILLED:      { bg: '#2d2200', border: '#5c4600', color: '#ffcc00', label: 'FILLED' },
  SL_ATTACHED: { bg: '#1a1f00', border: '#3a4800', color: '#c8e600', label: 'SL ATTACHED' },
  TP_ATTACHED: { bg: '#0d3320', border: '#1a5c38', color: '#2dff7a', label: 'COMPLETE' },
  CANCELLED:   { bg: '#1a0a00', border: '#7a3200', color: '#ff8c00', label: 'CANCELLED' },
  REJECTED:    { bg: '#320d0d', border: '#5c1a1a', color: '#ff4d4d', label: 'REJECTED' },
};

function ExecutionPanel({ result }: { result: ForexTradeResult }) {
  const state = result.executionState;
  const style = state ? STATE_STYLE[state] : null;

  return (
    <div style={{ marginTop: 16, fontFamily: "'JetBrains Mono', monospace", fontSize: 14 }}>

      {/* State badge row */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 14,
        padding: '12px 16px', borderRadius: 8,
        background: style?.bg ?? (result.success ? '#0d3320' : '#320d0d'),
        border: `1px solid ${style?.border ?? (result.success ? '#1a5c38' : '#5c1a1a')}`,
      }}>
        {style && (
          <span style={{
            background: style.bg, color: style.color,
            border: `1px solid ${style.border}`,
            padding: '4px 12px', borderRadius: 6, fontSize: 13, fontWeight: 800,
            letterSpacing: '0.5px',
          }}>
            {style.label}
          </span>
        )}
        <span style={{
          color: result.success ? '#2dff7a' : '#ff4d4d', flex: 1,
          fontSize: 14, fontWeight: 500, lineHeight: 1.5,
        }}>
          {result.success
            ? `tradeId: ${result.tradeId ?? '—'}  •  fill: ${result.fillPrice?.toFixed(5) ?? '—'}  •  ${formatUnits(result.units || 0)} units`
            : result.reason}
        </span>
      </div>

      {/* Cancel / reject reason — shown prominently */}
      {result.cancelReason && (
        <div style={{
          marginTop: 10, padding: '10px 16px', borderRadius: 8,
          background: '#1a0800', border: '1px solid #7a3200', color: '#ff8c00',
          fontSize: 14, lineHeight: 1.5,
        }}>
          OANDA cancel reason: <strong>{result.cancelReason}</strong>
        </div>
      )}
      {result.rejectReason && !result.cancelReason && (
        <div style={{
          marginTop: 10, padding: '10px 16px', borderRadius: 8,
          background: '#1a0000', border: '1px solid #5c0000', color: '#ff6666',
          fontSize: 14, lineHeight: 1.5,
        }}>
          Reject reason: <strong>{result.rejectReason}</strong>
        </div>
      )}

      {/* Margin row */}
      {(result.marginRequired !== undefined || result.marginAvailable !== undefined ||
        result.leverage !== undefined || result.notionalUSD !== undefined) && (
        <div style={{
          marginTop: 10, display: 'flex', gap: 20, flexWrap: 'wrap',
          padding: '10px 16px', borderRadius: 8,
          background: '#07070e', border: '1px solid #151528', color: '#888',
          fontSize: 14, lineHeight: 1.6,
        }}>
          {result.notionalUSD !== undefined && (
            <span>Notional: <span style={{ color: '#e0e0ff', fontWeight: 600 }}>${result.notionalUSD.toFixed(2)}</span></span>
          )}
          {result.leverage !== undefined && (
            <span>Leverage: <span style={{ color: '#4db8ff', fontWeight: 600 }}>{result.leverage.toFixed(1)}:1</span></span>
          )}
          {result.marginRequired !== undefined && (
            <span>Est. margin: <span style={{ color: '#e0e0ff', fontWeight: 600 }}>${result.marginRequired.toFixed(2)}</span></span>
          )}
          {result.marginAvailable !== undefined && (
            <span>Margin free: <span style={{ color: '#e0e0ff', fontWeight: 600 }}>${result.marginAvailable.toFixed(2)}</span></span>
          )}
          {result.projectedFreeMargin !== undefined && (
            <span>
              Proj. free:{' '}
              <span style={{
                color: result.projectedFreeMargin >= 0 ? '#2dff7a' : '#ff4d4d',
                fontWeight: 700,
              }}>
                ${result.projectedFreeMargin.toFixed(2)}
              </span>
            </span>
          )}
        </div>
      )}

      {/* Execution log — collapsible */}
      {result.executionLog && result.executionLog.length > 0 && (
        <details style={{ marginTop: 10 }}>
          <summary style={{ cursor: 'pointer', color: '#888', fontSize: 14, userSelect: 'none', padding: '4px 0', fontWeight: 600 }}>
            Execution log ({result.executionLog.length} events)
          </summary>
          <div style={{
            marginTop: 8, background: '#05050c', border: '1px solid #111120',
            borderRadius: 8, padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 6,
          }}>
            {result.executionLog.map((entry, i) => (
              <div key={i} style={{ display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <span style={{
                  color: entry.phase.includes('FAIL') || entry.phase.includes('ERROR') || entry.phase.includes('CANCEL') || entry.phase.includes('REJECT')
                    ? '#ff8c00' : '#2dff7a',
                  minWidth: 140, fontSize: 13, fontWeight: 700, letterSpacing: '0.3px',
                }}>
                  {entry.phase}
                </span>
                <span style={{ color: '#666', fontSize: 13 }}>
                  {entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : ''}
                </span>
                <span style={{ color: '#aaa', fontSize: 13 }}>
                  {entry.tradeId ? `tradeId: ${entry.tradeId}` : ''}
                  {entry.fillPrice ? `  price: ${entry.fillPrice}` : ''}
                  {entry.marginRequired ? `  margin: $${entry.marginRequired}` : ''}
                  {entry.cancelReason ? `  reason: ${entry.cancelReason}` : ''}
                  {entry.error ? `  error: ${entry.error}` : ''}
                </span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

// ─── Rejected row ─────────────────────────────────────────────────────────────

function RejectedRow({ sig }: { sig: ForexRejected }) {
  const pairDisplay = displayPair(sig.pair);
  const reasons = sig.rejectionReasons && sig.rejectionReasons.length > 0
    ? sig.rejectionReasons
    : sig.reason ? [sig.reason] : [];

  // Macro / structure / momentum biases — show only when the waterfall fired
  const hasWaterfall = sig.macro || sig.structure || sig.momentum ||
    (typeof sig.alignment === 'object' && sig.alignment !== null);
  const alignObj = typeof sig.alignment === 'object' && sig.alignment !== null
    ? sig.alignment as AlignmentResult
    : null;

  return (
    <div style={s.rejectedRow}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <span style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontWeight: 800, fontSize: 20, color: '#aaa', letterSpacing: '-0.2px',
        }}>
          {pairDisplay}
        </span>
        {sig.direction && (
          <Badge value={String(sig.direction).toUpperCase()} type={sig.direction === 'long' ? 'good' : 'bad'} />
        )}
        {sig.macro && (
          <Badge
            value={`macro ${sig.macro.macroBias}`}
            type={sig.macro.macroBias === 'bullish' ? 'good' : sig.macro.macroBias === 'bearish' ? 'bad' : 'warn'}
          />
        )}
        {alignObj && (
          <Badge value={`align ${alignObj.timeframeAlignmentScore}/100`} type="info" />
        )}
        {sig.rejectionCategory === 'news_blocked' && (
          <Badge value="NEWS BLOCKED" type="bad" />
        )}
        {sig.rejectionCategory === 'flow_opposes' && (
          <Badge value="FLOW OPPOSES" type="bad" />
        )}
        {sig.entryTiming && sig.entryTiming.status !== 'valid_entry' && (
          <Badge value={sig.entryTiming.status.replace(/_/g, ' ').toUpperCase()} type="warn" />
        )}
      </div>

      {/* Entry quality detail when rejection involved the new layer */}
      {(sig.fibonacci || sig.institutionalFlow || sig.newsRisk || sig.entryTiming) && (
        <EntryQualityPanel
          fibonacci={sig.fibonacci}
          institutionalFlow={sig.institutionalFlow}
          newsRisk={sig.newsRisk}
          entryTiming={sig.entryTiming}
          stopLossAnalysis={undefined}
        />
      )}

      {/* Per-timeframe pills when we have waterfall data */}
      {alignObj && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          {(['daily','h4','h1','m30','m15','m5'] as const).map(tf => (
            <TimeframePill key={tf} tf={tf.toUpperCase()} trend={alignObj.timeframes[tf]} />
          ))}
          {alignObj.conflictingTimeframes.length > 0 && (
            <span style={{
              fontSize: 14, color: '#ff8c00',
              fontFamily: "'JetBrains Mono', monospace",
              alignSelf: 'center', fontWeight: 600,
            }}>
              ⚠ conflicts: {alignObj.conflictingTimeframes.join(', ')}
            </span>
          )}
        </div>
      )}

      {/* Rejection reasons */}
      <div style={{
        fontSize: 14, color: '#cc4444', marginBottom: 12,
        display: 'flex', flexDirection: 'column', gap: 6, lineHeight: 1.5,
      }}>
        {reasons.map((r, i) => (
          <div key={i} style={{ display: 'flex', gap: 8 }}>
            <span style={{ color: '#ff4d4d', fontWeight: 700 }}>✗</span>
            <span>{r}</span>
          </div>
        ))}
      </div>

      {/* Footer metrics */}
      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
        {sig.confidence !== undefined && (
          <span style={{ fontSize: 14, fontFamily: "'JetBrains Mono', monospace", color: '#ff8888', fontWeight: 600 }}>
            Conf: {sig.confidence}%
          </span>
        )}
        {sig.spreadPips !== undefined && (
          <span style={{ fontSize: 14, fontFamily: "'JetBrains Mono', monospace", color: '#ff8c00', fontWeight: 600 }}>
            Spread: {sig.spreadPips.toFixed(1)} pips
          </span>
        )}
        {sig.session && (
          <span style={{ fontSize: 14, fontFamily: "'JetBrains Mono', monospace", color: '#888' }}>
            {sig.session}
          </span>
        )}
        {hasWaterfall && sig.macro && (
          <span style={{ fontSize: 14, fontFamily: "'JetBrains Mono', monospace", color: '#aaa' }}>
            macro conf {sig.macro.macroConfidence} · regime {sig.macro.volatilityRegime}
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Active Trade Card ────────────────────────────────────────────────────────

const STATE_COLOR: Record<string, { fg: string; bg: string; bd: string }> = {
  OPEN_HEALTHY:     { fg: '#2dff7a', bg: '#0d3320', bd: '#1a5c38' },
  ACCELERATING:    { fg: '#2dff7a', bg: '#0d3320', bd: '#1a5c38' },
  TP_LIKELY:       { fg: '#2dff7a', bg: '#0d3320', bd: '#1a5c38' },
  STALLING:        { fg: '#ffcc00', bg: '#2d2200', bd: '#5c4600' },
  WEAKENING:       { fg: '#ffcc00', bg: '#2d2200', bd: '#5c4600' },
  REVERSAL_RISK:   { fg: '#ff8c00', bg: '#2d1100', bd: '#7a3200' },
  EXIT_RECOMMENDED:{ fg: '#ff4d4d', bg: '#320d0d', bd: '#5c1a1a' },
  INVALIDATED:     { fg: '#ff4d4d', bg: '#320d0d', bd: '#5c1a1a' },
};

const REC_COLOR: Record<string, BadgeType> = {
  HOLD: 'good',
  HOLD_WITH_CAUTION: 'warn',
  MOVE_STOP_TO_BREAKEVEN: 'warn',
  TRAIL_STOP: 'info',
  TAKE_PARTIAL_PROFIT: 'info',
  CLOSE_TRADE: 'bad',
  CLOSE_IMMEDIATELY: 'bad',
};

function ActiveTradeCard({ trade }: { trade: import('../types/forex.ts').ActiveTradeAnalysis }) {
  if (trade.error) {
    return (
      <div style={{ ...s.card, borderColor: '#5c1a1a' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 800, fontSize: 20 }}>
            {displayPair(trade.instrument)}
          </span>
          <Badge value="ERROR" type="bad" />
        </div>
        <div style={{ marginTop: 10, color: '#ff8c00', fontSize: 14 }}>
          Analysis failed: {trade.error}
        </div>
      </div>
    );
  }
  const stateStyle = STATE_COLOR[trade.tradeState] || STATE_COLOR.OPEN_HEALTHY;
  const recType = REC_COLOR[trade.exitRecommendation] || 'neutral';
  const isLong = trade.side === 'long';
  const plColor = trade.unrealizedPL >= 0 ? '#2dff7a' : '#ff4d4d';
  const decayColor =
    trade.timeDecayRisk === 'low' ? '#2dff7a' :
    trade.timeDecayRisk === 'medium' ? '#ffcc00' : '#ff8c00';

  return (
    <div style={{ ...s.card, borderColor: stateStyle.bd, borderLeftWidth: 4, borderLeftStyle: 'solid', borderLeftColor: stateStyle.fg }}>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14, gap: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 800, fontSize: 24 }}>
              {displayPair(trade.instrument)}
            </span>
            <Badge value={isLong ? 'LONG' : 'SHORT'} type={isLong ? 'good' : 'bad'} />
            <Badge value={trade.tradeState} type="neutral" />
            <Badge value={`→ ${trade.exitRecommendation}`} type={recType} />
          </div>
          <div style={{ fontSize: 13, color: '#888', fontFamily: "'JetBrains Mono', monospace" }}>
            id {trade.tradeId} · open {trade.minutesElapsed} min ago · {trade.units.toLocaleString()} units
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 26, color: plColor, fontWeight: 800, lineHeight: 1.1 }}>
            ${trade.unrealizedPL.toFixed(2)}
          </div>
          <div style={{ fontSize: 13, color: '#888', marginTop: 4 }}>
            unrealized · {trade.unrealizedPips >= 0 ? '+' : ''}{trade.unrealizedPips.toFixed(1)} pips
          </div>
        </div>
      </div>

      {/* Price levels */}
      <div style={s.priceGrid}>
        <PriceCell label="Entry" value={trade.entryPrice.toFixed(5)} color="#e0e0ff" />
        <PriceCell label="Current" value={trade.currentPrice.toFixed(5)} color={plColor} />
        <PriceCell
          label="Stop Loss"
          value={trade.stopLoss != null ? trade.stopLoss.toFixed(5) : '—'}
          color="#ff4d4d"
          sub={`${trade.distanceToSLPips.toFixed(1)}p away`}
        />
        <PriceCell
          label="Take Profit"
          value={trade.takeProfit != null ? trade.takeProfit.toFixed(5) : '—'}
          color="#2dff7a"
          sub={`${trade.distanceToTPPips.toFixed(1)}p to go (${(trade.tpProgress * 100).toFixed(0)}% covered)`}
        />
      </div>

      {/* Live stats grid */}
      <div style={s.sizingGrid}>
        <SizingCell label="Alignment" value={`${trade.currentAlignmentScore}/100`} />
        <SizingCell label="Confidence" value={`${trade.currentConfidence}%`} />
        <SizingCell label="TP prob" value={`${(trade.tpProbability * 100).toFixed(0)}%`} />
        <SizingCell label="SL prob" value={`${(trade.slProbability * 100).toFixed(0)}%`} />
        <SizingCell
          label="Hold left"
          value={`${trade.updatedHoldWindow.minMinutes}–${trade.updatedHoldWindow.maxMinutes}m`}
        />
      </div>

      {/* Decay + reason */}
      <div style={{
        background: stateStyle.bg, border: `1px solid ${stateStyle.bd}`, borderRadius: 8,
        padding: '12px 16px', marginBottom: 14, fontSize: 14, lineHeight: 1.5,
      }}>
        <div style={{ marginBottom: 6 }}>
          <span style={{ color: '#888' }}>Reason:</span>{' '}
          <span style={{ color: stateStyle.fg, fontWeight: 600 }}>{trade.exitReason}</span>
        </div>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 13, color: '#aaa' }}>
          <span>time-decay: <span style={{ color: decayColor, fontWeight: 700 }}>{trade.timeDecayRisk}</span></span>
          {trade.macroOpposes && <span style={{ color: '#ff6666', fontWeight: 700 }}>⚠ macro opposes</span>}
          {trade.alignmentDropped && <span style={{ color: '#ff8c00', fontWeight: 700 }}>⚠ alignment dropped</span>}
          {trade.conflictingTfCount > 0 && (
            <span>conflicts: <span style={{ color: '#ff8c00', fontWeight: 700 }}>{trade.conflictingTfCount}</span></span>
          )}
        </div>
      </div>

      {/* Mini waterfall */}
      <details>
        <summary style={{ cursor: 'pointer', color: '#888', fontSize: 14, userSelect: 'none', padding: '4px 0', fontWeight: 600 }}>
          Mini waterfall (current state)
        </summary>
        <div style={{ marginTop: 10 }}>
          <WaterfallPanel
            macro={trade.waterfall.macro}
            structure={trade.waterfall.structure}
            momentum={trade.waterfall.momentum}
            alignment={trade.waterfall.alignment}
            direction={trade.side}
          />
        </div>
      </details>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function ForexSignalStackTab() {
  const [diag, setDiag] = useState<OandaDiagnostics | null>(null);
  const [tradeState, setTradeState] = useState<ForexTradeState | null>(null);
  const [scanResult, setScanResult] = useState<ForexScanResult | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [tradeResults, setTradeResults] = useState<Record<string, ForexTradeResult>>({});
  const [activeTab, setActiveTab] = useState<'qualified' | 'rejected' | 'active'>('qualified');
  const [lastScanTime, setLastScanTime] = useState<string | null>(null);
  const [activeTrades, setActiveTrades] = useState<import('../types/forex.ts').ActiveTradesResponse | null>(null);
  const [activeLoading, setActiveLoading] = useState(false);
  const [activeError, setActiveError] = useState<string | null>(null);

  const refreshActiveTrades = useCallback(async () => {
    setActiveLoading(true);
    setActiveError(null);
    try {
      const result = await fetchActiveTrades();
      setActiveTrades(result);
    } catch (err: unknown) {
      setActiveError(err instanceof Error ? err.message : 'Failed to fetch active trades');
    } finally {
      setActiveLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDiagnostics().then(setDiag).catch(() => {});
    fetchTradeState().then(setTradeState).catch(() => {});
    refreshActiveTrades();
  }, [refreshActiveTrades]);

  const runScan = useCallback(async () => {
    setIsScanning(true);
    setScanError(null);
    try {
      const result = await fetchScan();
      setScanResult(result);
      setLastScanTime(new Date().toLocaleTimeString());
      const state = await fetchTradeState();
      setTradeState(state);
    } catch (err: unknown) {
      setScanError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsScanning(false);
    }
  }, []);

  const handleTrade = useCallback(async (signal: ForexSignal) => {
    const key = `${signal.pair}_${signal.direction}`;
    try {
      const result = await submitTrade(signal);
      setTradeResults(prev => ({ ...prev, [key]: result }));
      const state = await fetchTradeState();
      setTradeState(state);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Trade failed';
      setTradeResults(prev => ({ ...prev, [key]: { success: false, blocked: false, reason: msg } }));
    }
  }, []);

  const qualified = scanResult?.qualified || [];
  const rejected = scanResult?.rejected || [];
  const watchlistCount = scanResult?.meta.watchlist.length ?? '…';

  return (
    <div style={s.container}>

      {/* Header */}
      <div style={s.header}>
        <div>
          <div style={s.title}>
            <span style={{ color: '#4db8ff' }}>Signal Stack</span>
            <span style={{ color: '#2dff7a', marginLeft: 12 }}>Forex &amp; Metals</span>
          </div>
          <div style={s.subtitle}>
            OANDA v20 · {diag?.env === 'live' ? '🔴 LIVE' : '🟡 PRACTICE'} · Backend-generated signals only
          </div>
        </div>
        <button
          onClick={runScan}
          disabled={isScanning}
          style={{ ...s.scanBtn, opacity: isScanning ? 0.6 : 1 }}
        >
          {isScanning ? '⟳ Scanning…' : '⟳ Run Scan'}
        </button>
      </div>

      {/* Dynamic per-trade risk mode banner */}
      {(scanResult?.meta?.aggressiveRiskWarning || scanResult?.meta?.riskMode) && (
        <div style={s.aggressiveBanner}>
          <span style={{ fontWeight: 800, marginRight: 10, fontSize: 16, letterSpacing: '0.5px' }}>
            {scanResult?.meta?.riskMode === 'dynamic' ? '⚙ DYNAMIC RISK MODE' : '⚠ FIXED-DOLLAR RISK MODE'}
          </span>
          {scanResult?.meta?.aggressiveRiskWarning}
          {scanResult?.meta?.riskMode === 'dynamic' && scanResult?.meta?.minRiskPercent !== undefined && (
            <span style={{ marginLeft: 10, opacity: 0.9, fontWeight: 500 }}>
              · {scanResult.meta.minRiskPercent}–{scanResult.meta.maxRiskPercent}% of balance
              {scanResult.meta.accountBalanceUSD != null
                && ` ($${(scanResult.meta.accountBalanceUSD * (scanResult.meta.minRiskPercent! / 100)).toFixed(2)}–$${(scanResult.meta.accountBalanceUSD * (scanResult.meta.maxRiskPercent! / 100)).toFixed(2)} on $${scanResult.meta.accountBalanceUSD.toFixed(2)})`}
              {' '}· SL/TP dynamic per setup · min 1:{scanResult.meta.minimumRiskReward ?? 1.5}
            </span>
          )}
        </div>
      )}

      {/* Status row */}
      <div style={s.statusRow}>
        <StatusBlock label="Connection">
          <Badge value={diag?.connectionOk ? 'CONNECTED' : 'OFFLINE'} type={diag?.connectionOk ? 'good' : 'bad'} />
        </StatusBlock>
        <StatusBlock label="Auto-Trade">
          <Badge value={tradeState?.autoTradeEnabled ? 'ENABLED' : 'DISABLED'} type={tradeState?.autoTradeEnabled ? 'warn' : 'neutral'} />
        </StatusBlock>
        <StatusBlock label="Daily Trades">
          <Badge
            value={tradeState ? `${tradeState.dailyTradesCount}/${tradeState.dailyTradesCap}` : '—'}
            type={tradeState && tradeState.dailyTradesCount >= tradeState.dailyTradesCap ? 'bad' : 'good'}
          />
        </StatusBlock>
        {scanResult && (
          <StatusBlock label="Session">
            <Badge value={scanResult.meta.session} type="info" />
          </StatusBlock>
        )}
        {lastScanTime && (
          <StatusBlock label="Last Scan">
            <Badge value={lastScanTime} type="info" />
          </StatusBlock>
        )}
      </div>

      <div style={s.mainGrid}>

        {/* Left: diagnostics + trade state + scan summary */}
        <div style={s.leftCol}>
          <SectionTitle>Diagnostics</SectionTitle>
          <DiagnosticsPanel diag={diag} />

          <SectionTitle style={{ marginTop: 20 }}>Trade State</SectionTitle>
          <TradeStatePanel state={tradeState} />

          {scanResult && (
            <>
              <SectionTitle style={{ marginTop: 20 }}>Scan Summary</SectionTitle>
              <div style={s.panel}>
                <div style={s.diagGrid}>
                  <DiagRow label="Watchlist" value={`${scanResult.meta.pairsScanned} instruments`} type="info" />
                  <DiagRow label="Qualified" value={String(scanResult.meta.totalQualified)} type={scanResult.meta.totalQualified > 0 ? 'good' : 'neutral'} />
                  <DiagRow label="Rejected" value={String(scanResult.meta.totalRejected)} type="neutral" />
                  <DiagRow
                    label="Min Alignment"
                    value={`${scanResult.meta.minAlignmentScore ?? 55}/100`}
                    type="info"
                  />
                  <DiagRow label="Min Confidence" value={`${scanResult.meta.minConfidence}%`} type="info" />
                  <DiagRow label="Forex Spread" value={`≤ ${scanResult.meta.maxSpreadPips}p`} type="info" />
                  <DiagRow label="Metals Spread" value={`≤ ${scanResult.meta.metalsMaxSpreadPips ?? 50}p`} type="metal" />
                  <DiagRow label="Lot Size" value="Dynamic per trade" type="info" />
                  {scanResult.meta.riskMode === 'dynamic' && scanResult.meta.minRiskPercent !== undefined && (
                    <DiagRow
                      label="Risk %"
                      value={`${scanResult.meta.minRiskPercent}–${scanResult.meta.maxRiskPercent}% (conf-scaled)`}
                      type="warn"
                    />
                  )}
                  {scanResult.meta.accountBalanceUSD != null && (
                    <DiagRow
                      label="Account"
                      value={`$${scanResult.meta.accountBalanceUSD.toFixed(2)}`}
                      type="info"
                    />
                  )}
                  <DiagRow
                    label="Stop / TP"
                    value="Dynamic per setup"
                    type="info"
                  />
                  <DiagRow
                    label="Risk / Reward"
                    value={`min 1 : ${scanResult.meta.minimumRiskReward ?? 1.5}`}
                    type="good"
                  />
                </div>
                {scanResult.meta.watchlist.length > 0 && (
                  <div style={{
                    marginTop: 14, fontSize: 13, color: '#888',
                    fontFamily: "'JetBrains Mono', monospace", lineHeight: 1.7,
                  }}>
                    {scanResult.meta.watchlist.map(displayPair).join(' · ')}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* Right: signal results */}
        <div style={s.rightCol}>

          {!scanResult && !isScanning && !scanError && (
            <div style={s.emptyState}>
              <div style={{ fontSize: 48, marginBottom: 18 }}>📡</div>
              <div style={{ color: '#aaa', marginBottom: 12, fontSize: 18, fontWeight: 600 }}>No scan results yet.</div>
              <div style={{ color: '#888', fontSize: 14, lineHeight: 1.5 }}>Click "Run Scan" to analyze live OANDA market data.</div>
            </div>
          )}

          {isScanning && (
            <div style={s.emptyState}>
              <div style={{ fontSize: 44, marginBottom: 18, display: 'inline-block', animation: 'spin 1s linear infinite' }}>⟳</div>
              <div style={{ color: '#4db8ff', fontSize: 18, fontWeight: 600 }}>Scanning {watchlistCount} instruments…</div>
              <div style={{ color: '#888', fontSize: 14, marginTop: 12, lineHeight: 1.5 }}>
                Fetching live pricing and candle data from OANDA
              </div>
            </div>
          )}

          {scanError && (
            <div style={s.errorBox}>
              <strong style={{ fontSize: 16 }}>Scan failed:</strong> {scanError}
              <div style={{ marginTop: 12, fontSize: 14, color: '#cc6666', lineHeight: 1.5 }}>
                Check that OANDA_API_KEY and OANDA_ACCOUNT_ID are set in your .env file and the server is running.
              </div>
            </div>
          )}

          {scanResult && (
            <>
              <div style={s.tabBar}>
                <button
                  onClick={() => setActiveTab('qualified')}
                  style={{ ...s.tabBtn, ...(activeTab === 'qualified' ? s.tabBtnActive : {}) }}
                >
                  ✓ Qualified ({qualified.length})
                </button>
                <button
                  onClick={() => setActiveTab('rejected')}
                  style={{ ...s.tabBtn, ...(activeTab === 'rejected' ? s.tabBtnActive : {}) }}
                >
                  ✗ Rejected ({rejected.length})
                </button>
                <button
                  onClick={() => { setActiveTab('active'); refreshActiveTrades(); }}
                  style={{ ...s.tabBtn, ...(activeTab === 'active' ? s.tabBtnActive : {}) }}
                >
                  ⚙ Active Trades ({activeTrades?.trades?.length ?? 0})
                </button>
              </div>

              {activeTab === 'qualified' && (
                <div>
                  {qualified.length === 0 ? (
                    <div style={s.emptyState}>
                      <div style={{ fontSize: 40, marginBottom: 14 }}>🔍</div>
                      <div style={{ color: '#aaa', fontSize: 18, fontWeight: 600 }}>No signals met the qualification threshold.</div>
                      <div style={{ color: '#888', fontSize: 14, marginTop: 12, lineHeight: 1.5 }}>
                        Need alignment ≥ {scanResult.meta.minAlignmentScore ?? 55}/100 and confidence ≥ {scanResult.meta.minConfidence}%
                      </div>
                    </div>
                  ) : (
                    qualified.map(sig => {
                      const key = `${sig.pair}_${sig.direction}`;
                      return (
                        <SignalCard
                          key={key}
                          signal={sig}
                          onTrade={handleTrade}
                          tradeResult={tradeResults[key] || null}
                        />
                      );
                    })
                  )}
                </div>
              )}

              {activeTab === 'rejected' && (
                <div>
                  {rejected.length === 0 ? (
                    <div style={s.emptyState}>
                      <div style={{ color: '#aaa', fontSize: 18, fontWeight: 600 }}>No rejections — all pairs qualified.</div>
                    </div>
                  ) : (
                    rejected.map((sig, i) => <RejectedRow key={i} sig={sig} />)
                  )}
                </div>
              )}

              {activeTab === 'active' && (
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                    <span style={{ color: '#888', fontSize: 14 }}>
                      Last reassessment:{' '}
                      <span style={{ color: '#aaa', fontWeight: 600 }}>
                        {activeTrades?.meta?.scannedAt ? new Date(activeTrades.meta.scannedAt).toLocaleTimeString() : '—'}
                      </span>
                      {activeTrades?.meta?.autoCloseEnabled === false && (
                        <span style={{ marginLeft: 12, color: '#ffcc00', fontWeight: 700 }}>
                          · auto-close OFF (recommendations only)
                        </span>
                      )}
                    </span>
                    <button
                      onClick={refreshActiveTrades}
                      disabled={activeLoading}
                      style={{ ...s.scanBtn, padding: '10px 20px', fontSize: 14, opacity: activeLoading ? 0.6 : 1 }}
                    >
                      {activeLoading ? '⟳ Reassessing…' : '⟳ Reassess'}
                    </button>
                  </div>
                  {activeError && (
                    <div style={s.errorBox}><strong>Failed:</strong> {activeError}</div>
                  )}
                  {!activeTrades?.trades?.length && !activeError && !activeLoading && (
                    <div style={s.emptyState}>
                      <div style={{ fontSize: 40, marginBottom: 14 }}>📭</div>
                      <div style={{ color: '#aaa', fontSize: 18, fontWeight: 600 }}>No open trades on the OANDA account.</div>
                      <div style={{ color: '#888', fontSize: 14, marginTop: 12 }}>
                        {activeTrades?.meta?.notice || 'Open a position to see live reassessment here.'}
                      </div>
                    </div>
                  )}
                  {activeTrades?.trades?.map(t => (
                    <ActiveTradeCard key={t.tradeId} trade={t} />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <div style={s.footer}>
        Signal Stack · OANDA v20 · Small Repeatable Wins · Forex + Metals · Capital Protected
        {diag?.env === 'practice' && ' · 🟡 PRACTICE MODE — No real money at risk'}
      </div>

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}

// ─── Small layout helpers ─────────────────────────────────────────────────────

function SectionTitle({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      fontSize: 14, color: '#aaa',
      textTransform: 'uppercase' as const, letterSpacing: '1.2px',
      marginBottom: 12, fontWeight: 700,
      ...style,
    }}>
      {children}
    </div>
  );
}

function StatusBlock({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 8 }}>
      <div style={{
        fontSize: 13, color: '#888',
        textTransform: 'uppercase' as const, letterSpacing: '0.8px', fontWeight: 600,
      }}>{label}</div>
      {children}
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  container: {
    background: '#0a0a12',
    minHeight: '100vh',
    color: '#e0e0ff',
    fontFamily: "'Inter', 'Segoe UI', system-ui, Roboto, sans-serif",
    fontSize: 15,
    lineHeight: 1.5,
    padding: '32px',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 28,
    gap: 16,
  },
  title: {
    fontSize: 34,
    fontWeight: 800,
    letterSpacing: '-0.5px',
    fontFamily: "'Inter', 'Segoe UI', system-ui, sans-serif",
    lineHeight: 1.2,
  },
  subtitle: {
    fontSize: 14,
    color: '#888',
    marginTop: 6,
    fontFamily: "'JetBrains Mono', ui-monospace, Consolas, monospace",
  },
  scanBtn: {
    background: 'linear-gradient(135deg, #1a4060, #0d2030)',
    border: '1px solid #2a6090',
    color: '#4db8ff',
    padding: '14px 28px',
    borderRadius: 10,
    cursor: 'pointer',
    fontSize: 16,
    fontWeight: 700,
    fontFamily: "'Inter', 'Segoe UI', sans-serif",
    transition: 'opacity 0.2s',
    minHeight: 48,
    letterSpacing: '0.3px',
  },
  statusRow: {
    display: 'flex',
    gap: 24,
    flexWrap: 'wrap',
    marginBottom: 28,
    padding: '16px 22px',
    background: '#0d0d1a',
    borderRadius: 10,
    border: '1px solid #1a1a2e',
  },
  mainGrid: {
    display: 'grid',
    gridTemplateColumns: '340px 1fr',
    gap: 28,
    alignItems: 'start',
  },
  leftCol: {
    position: 'sticky',
    top: 24,
  },
  rightCol: {
    minWidth: 0,
  },
  panel: {
    background: '#0d0d1a',
    border: '1px solid #1a1a2e',
    borderRadius: 10,
    padding: '18px 22px',
  },
  diagGrid: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  card: {
    background: '#0d0d1a',
    border: '1px solid #1e1e30',
    borderRadius: 12,
    padding: '24px 26px',
    marginBottom: 20,
  },
  priceGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    gap: 12,
    background: '#08080f',
    borderRadius: 8,
    padding: '16px 14px',
    marginBottom: 14,
  },
  sizingGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(5, 1fr)',
    gap: 12,
    background: '#0a0a10',
    borderRadius: 8,
    padding: '14px 12px',
    marginBottom: 14,
    border: '1px solid #111120',
  },
  riskGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(6, 1fr)',
    gap: 12,
    background: '#11070a',
    borderRadius: 8,
    padding: '14px 12px',
    marginBottom: 14,
    border: '1px solid #3a1620',
  },
  sizingFactorsBox: {
    background: '#07070e',
    border: '1px solid #151528',
    borderRadius: 6,
    padding: '8px 14px',
    marginBottom: 12,
    fontSize: 13,
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    letterSpacing: '0.2px',
  },
  aggressiveBanner: {
    background: 'linear-gradient(135deg, #2d1100, #401400)',
    border: '1px solid #ff8c00',
    color: '#ffcc66',
    borderRadius: 10,
    padding: '14px 20px',
    marginBottom: 20,
    fontFamily: "'Inter', 'Segoe UI', sans-serif",
    fontSize: 14,
    lineHeight: 1.5,
    letterSpacing: '0.3px',
  },
  sizingWarnBox: {
    background: '#1a0a00',
    border: '1px solid #7a3200',
    color: '#ff8c00',
    borderRadius: 8,
    padding: '10px 14px',
    marginBottom: 12,
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    fontSize: 13,
    lineHeight: 1.55,
  },
  conflictBanner: {
    background: '#1a0a00',
    border: '1px solid #7a3200',
    borderRadius: 6,
    padding: '8px 14px',
    marginBottom: 12,
    fontSize: 13,
    color: '#ff8c00',
    fontFamily: "'Inter', sans-serif",
    fontWeight: 600,
    letterSpacing: '0.2px',
  },
  intradayGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(5, 1fr)',
    gap: 10,
    background: '#07070e',
    border: '1px solid #151528',
    borderRadius: 8,
    padding: '14px 10px',
    marginBottom: 14,
  },
  indicatorRow: {
    display: 'flex',
    gap: 22,
    flexWrap: 'wrap',
    marginTop: 6,
  },
  breakdownGrid: {
    background: '#08080f',
    borderRadius: 8,
    padding: '12px 14px',
    marginTop: 8,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  tradeBtn: {
    background: 'linear-gradient(135deg, #0d3320, #1a5c38)',
    border: '1px solid #2dff7a',
    color: '#2dff7a',
    padding: '12px 28px',
    borderRadius: 8,
    cursor: 'pointer',
    fontSize: 16,
    fontWeight: 700,
    fontFamily: "'Inter', 'Segoe UI', sans-serif",
    transition: 'opacity 0.2s',
    minHeight: 48,
    letterSpacing: '0.3px',
  },
  rejectedRow: {
    background: '#0a0a12',
    border: '1px solid #1a1218',
    borderRadius: 10,
    padding: '16px 20px',
    marginBottom: 10,
  },
  tabBar: {
    display: 'flex',
    gap: 6,
    marginBottom: 20,
    background: '#0d0d1a',
    borderRadius: 10,
    padding: 6,
    border: '1px solid #1a1a2e',
  },
  tabBtn: {
    flex: 1,
    padding: '12px 16px',
    borderRadius: 8,
    border: 'none',
    background: 'transparent',
    color: '#888',
    cursor: 'pointer',
    fontSize: 15,
    fontFamily: "'Inter', sans-serif",
    fontWeight: 600,
    transition: 'all 0.2s',
    minHeight: 44,
    letterSpacing: '0.2px',
  },
  tabBtnActive: {
    background: '#1a1a2e',
    color: '#e0e0ff',
  },
  emptyState: {
    textAlign: 'center',
    padding: '80px 28px',
    color: '#888',
    fontSize: 15,
  },
  errorBox: {
    background: '#1a0808',
    border: '1px solid #5c1a1a',
    borderRadius: 10,
    padding: '16px 22px',
    color: '#ff6666',
    fontSize: 15,
    lineHeight: 1.55,
    marginBottom: 20,
  },
  footer: {
    marginTop: 40,
    padding: '20px 0',
    borderTop: '1px solid #1a1a2e',
    textAlign: 'center',
    fontSize: 14,
    color: '#666',
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    letterSpacing: '0.4px',
    lineHeight: 1.6,
  },
};
