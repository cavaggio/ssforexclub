/**
 * web/components/scanner-status-card.tsx
 *
 * Rich scanner panel for the production dashboard. Ports the qualified /
 * rejected / open-trade / 30-min reassessment display from the legacy Vite
 * dashboard (src/components/ForexSignalStackTab.tsx) so the deployed Next.js
 * dashboard renders full signal intelligence — waterfall layers, entry-quality
 * gates, lifecycle reasoning, and live trade reassessment — instead of just
 * summary counts.
 *
 * Data sources — ALL via authenticated Next.js API routes (never Railway
 * directly from the browser). Each route resolves the caller's Clerk identity,
 * fetches their broker credentials from Supabase server-side, and forwards a
 * server-to-server request to the Railway scanner. The user's token never
 * touches the browser.
 *
 *   - POST /api/scanner/scan                       — qualified + rejected + meta
 *   - POST /api/scanner/active-trades/analysis     — live trade reassessment
 *   - POST /api/scanner/active-trades/reassess     — 30-min management plans
 *
 * Normalized response wrapper:
 *   { ok, scan: { qualified, rejected, meta }, activeBroker,
 *     activeEnvironment, isLiveTrading }
 */

'use client';

import { useCallback, useEffect, useState } from 'react';

// Mirrors the row shape exposed by web/lib/tradeLogs.ts. Kept inline to avoid
// importing the server-only helper from a client component.
type TradeLogRow = {
  id: string;
  created_at: string;
  broker: string;
  broker_account_id: string | null;
  environment: string;
  event_type:
    | 'opened' | 'closed' | 'partial_closed' | 'tp_updated' | 'sl_updated'
    | 'reassessed' | 'auto_close_recommended' | 'manual_close_executed' | 'error';
  instrument: string | null;
  trade_id: string | null;
  broker_order_id: string | null;
  side: 'long' | 'short' | null;
  units: number | null;
  units_closed: number | null;
  entry_price: number | null;
  exit_price: number | null;
  realized_pl: number | null;
  unrealized_pl: number | null;
  tp: number | null;
  sl: number | null;
  recommendation: string | null;
  confidence: number | null;
  reason: string | null;
  raw_payload: unknown;
};

import type {
  ForexScanResult,
  ForexSignal,
  ForexRejected,
  ActiveTradeAnalysis,
  ActiveTradesResponse,
  CalibrationSnapshot,
  MacroAnalysis,
  StructureAnalysis,
  MomentumAnalysis,
  AlignmentResult,
  FibonacciAnalysis,
  InstitutionalFlow,
  ForexNewsRisk,
  EntryTiming,
  StopLossAnalysis,
  V3Meta,
} from '@/types/forex';

// ─── Normalized envelope ──────────────────────────────────────────────────────

type NormalizedScan = {
  ok: boolean;
  scan: ForexScanResult;
  activeBroker: string;
  activeEnvironment: string;
  isLiveTrading: boolean;
  error?: string;
  brokerCredentialStatus?: string;
};

// ─── Reassess shape (lightweight management-plan per trade) ───────────────────

type ReassessTrade = {
  tradeId: string;
  instrument: string;
  direction?: 'long' | 'short';
  units?: number;
  recommendedAction?: string;
  currentPnL?: number;
  profitRMultiple?: number;
  distanceToTP?: number;
  distanceToSL?: number;
  marketState?: string;
  marketStateScore?: number;
  candleStrengthScore?: number;
  multiTimeframeAlignmentScore?: number;
  currentAlignmentScore?: number;
  currentConfidence?: number;
  managementReasons?: string[];
  recommendedStopLoss?: number | null;
  recommendedTakeProfit?: number | null;
  partialExitPercent?: number | null;
  classicTradeState?: string;
  classicExitRecommendation?: string;
  minutesElapsed?: number;
  tpProgress?: number;
  // Dynamic lifecycle engine output (2026-05-30)
  velocityScore?: number;
  momentumDecayScore?: number;
  momentumStatus?: 'improving' | 'stable' | 'decaying';
  holdStatus?: 'on_track' | 'slow' | 'expired' | 'invalidated';
  holdRatio?: number;
  expectedRemainingHoldTime?: number;
  dynamicTP?: {
    minTargetPips: number;
    baseTargetPips: number;
    maxTargetPips: number;
    currentRecommendedTargetPips: number;
  };
  opportunityCostScore?: number;
  // Signal Stack V3 — pro exit framework
  breakeven?: { eligible: boolean; recommendedSL: number | null; reason: string };
  multiTargets?: {
    stages: Array<{ stage: string; multiple: number; pips: number; price: number }>;
    currentStage: 'pre-TP1' | 'TP1' | 'TP2' | 'TP3+';
  };
  partialClose?: { recommendedPartialClosePercent: number; reason: string };
  dynamicTrail?: {
    recommended: boolean;
    distancePips: number | null;
    price: number | null;
    multiplier: number | null;
  };
  trendExhaustion?: {
    trendExhaustionScore: number;
    trendExhaustionStatus: 'normal' | 'extended' | 'exhausted';
  };
  capitalEfficiency?: {
    capitalEfficiencyScore: number;
    capitalEfficiencyLabel: 'Excellent' | 'Good' | 'Average' | 'Poor' | 'Exit Candidate';
  };
  lifecycleRecommendation?: {
    action: 'hold' | 'tighten_sl' | 'reduce_tp' | 'expand_tp' | 'partial_close' | 'close';
    reason: string;
    urgency: 'low' | 'medium' | 'high';
    confidence: number;
    suggestedNewSL: number | null;
    suggestedNewTP: number;
    shouldAutoClose: boolean;
    autoCloseReason: string | null;
    source?: string;
    conflictNotes?: string[];
    unifiedSummary?: string;
  };
  error?: string;
};

type ReassessResponse = {
  trades: ReassessTrade[];
  meta: {
    reassessedAt?: string;
    session?: string;
    environment?: string;
    totalActive?: number;
    recommendationCounts?: Record<string, number>;
    autoCloseEnabled?: boolean;
    nextReassessmentDueAt?: string;
    notice?: string;
    error?: string;
  };
};

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

// ─── Badge ────────────────────────────────────────────────────────────────────

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
    <span
      style={{
        ...styles[type],
        padding: '5px 12px',
        borderRadius: 6,
        fontSize: 13,
        fontWeight: 700,
        fontFamily: "'JetBrains Mono', ui-monospace, monospace",
        whiteSpace: 'nowrap',
        letterSpacing: '0.3px',
        lineHeight: 1.3,
      }}
    >
      {value}
    </span>
  );
}

function ScoreBar({ score, max = 100, minScore = 55 }: { score: number; max?: number; minScore?: number }) {
  const pct = Math.max(0, Math.min(100, Math.round((score / max) * 100)));
  const minPct = Math.round((minScore / max) * 100);
  const color = pct >= 75 ? '#2dff7a' : pct >= minPct ? '#ffcc00' : '#ff4d4d';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <div style={{ flex: 1, background: '#1a1a2e', borderRadius: 6, height: 12, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 6 }} />
      </div>
      <span
        style={{
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          fontSize: 16,
          fontWeight: 700,
          color,
          minWidth: 64,
          textAlign: 'right',
        }}
      >
        {score}/{max}
      </span>
    </div>
  );
}

// ─── Waterfall panel ──────────────────────────────────────────────────────────

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
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 4,
        padding: '8px 12px',
        borderRadius: 8,
        background: '#08080f',
        border: `1px solid ${color}55`,
        minWidth: 78,
      }}
    >
      <span
        style={{
          fontSize: 11,
          color: '#888',
          letterSpacing: '0.8px',
          textTransform: 'uppercase',
          fontWeight: 600,
        }}
      >
        {tf}
      </span>
      <span
        style={{
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          fontSize: 13,
          fontWeight: 700,
          color,
          lineHeight: 1.2,
        }}
      >
        {trend === 'bullish' ? '▲' : trend === 'bearish' ? '▼' : '·'} {trend === 'neutral' ? 'flat' : trend}
      </span>
    </div>
  );
}

function MiniBar({ value, max = 100, color = '#4db8ff' }: { value: number; max?: number; color?: string }) {
  const pct = Math.max(0, Math.min(100, Math.round((value / max) * 100)));
  return (
    <div style={{ background: '#1a1a2e', borderRadius: 5, height: 10, overflow: 'hidden' }}>
      <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 5 }} />
    </div>
  );
}

function WaterfallPanel({
  macro,
  structure,
  momentum,
  alignment,
  direction,
}: {
  macro: MacroAnalysis;
  structure: StructureAnalysis;
  momentum: MomentumAnalysis;
  alignment: AlignmentResult;
  direction: 'long' | 'short' | 'neutral';
}) {
  const macroColor =
    macro.macroBias === 'bullish' ? '#2dff7a' : macro.macroBias === 'bearish' ? '#ff4d4d' : '#ffcc00';
  const alignColor =
    alignment.alignmentStatus === 'strong'
      ? '#2dff7a'
      : alignment.alignmentStatus === 'mixed'
        ? '#ffcc00'
        : '#ff4d4d';
  const revColor =
    structure.reversalRisk === 'low' ? '#2dff7a' : structure.reversalRisk === 'medium' ? '#ffcc00' : '#ff4d4d';

  return (
    <div style={wfStyles.container}>
      <div style={wfStyles.timeframeRow}>
        <TimeframePill tf="Daily" trend={alignment.timeframes.daily} />
        <TimeframePill tf="H4" trend={alignment.timeframes.h4} />
        <TimeframePill tf="H1" trend={alignment.timeframes.h1} />
        <TimeframePill tf="M30" trend={alignment.timeframes.m30} />
        <TimeframePill tf="M15" trend={alignment.timeframes.m15} />
        <TimeframePill tf="M5" trend={alignment.timeframes.m5} />
      </div>

      <div style={wfStyles.layerRow}>
        <div style={wfStyles.layerLabel}>L1 Macro</div>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 15, color: macroColor, fontWeight: 800 }}>
              {biasLabel(macro.macroBias)}
            </span>
            <span style={{ fontSize: 13, color: '#888' }}>
              · Daily {macro.dailyTrend} · H4 {macro.h4Trend} · regime {macro.volatilityRegime}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 14, marginTop: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: '#aaa', minWidth: 84 }}>conf {macro.macroConfidence}</span>
            <div style={{ flex: 1 }}>
              <MiniBar value={macro.macroConfidence} color={macroColor} />
            </div>
            <span style={{ fontSize: 12, color: '#aaa' }}>str {macro.trendStrength}</span>
          </div>
        </div>
      </div>

      <div style={wfStyles.layerRow}>
        <div style={wfStyles.layerLabel}>L2 Structure</div>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 15,
                fontWeight: 800,
                color: structure.structureAligned ? '#2dff7a' : '#ffcc00',
              }}
            >
              {structure.structureAligned ? '✓ Aligned' : '✗ Misaligned'}
            </span>
            {structure.pullbackDetected && <Badge value="Pullback" type="info" />}
            <Badge
              value={`reversal ${structure.reversalRisk}`}
              type={structure.reversalRisk === 'low' ? 'good' : structure.reversalRisk === 'medium' ? 'warn' : 'bad'}
            />
            <span style={{ fontSize: 13, color: '#888' }}>
              · H1 {structure.h1Trend} · M30 {structure.m30Trend}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 14, marginTop: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: '#aaa', minWidth: 84 }}>conf {structure.structuralConfidence}</span>
            <div style={{ flex: 1 }}>
              <MiniBar value={structure.structuralConfidence} color={revColor} />
            </div>
            <span style={{ fontSize: 12, color: '#aaa' }}>cont {structure.continuationProbability}%</span>
          </div>
          {structure.nearKeyLevel && (
            <div style={{ marginTop: 8, fontSize: 12, color: '#ffaa00', fontWeight: 600 }}>
              ⚠ {structure.nearKeyLevel.distancePips}p to H4 {structure.nearKeyLevel.kind} @{' '}
              {structure.nearKeyLevel.price}
            </div>
          )}
        </div>
      </div>

      <div style={wfStyles.layerRow}>
        <div style={wfStyles.layerLabel}>L3 Momentum</div>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 15,
                fontWeight: 800,
                color: momentum.executionSignal
                  ? trendColor(momentum.executionSignal === 'long' ? 'bullish' : 'bearish')
                  : '#888',
              }}
            >
              trigger {momentum.executionSignal ? momentum.executionSignal.toUpperCase() : 'NONE'}
            </span>
            <span style={{ fontSize: 13, color: '#888' }}>
              · M15 {momentum.m15Trend} · M5 {momentum.m5Trend} · candle {momentum.candleConfirmation}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 14, marginTop: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: '#aaa', minWidth: 84 }}>conf {momentum.executionConfidence}</span>
            <div style={{ flex: 1 }}>
              <MiniBar
                value={momentum.executionConfidence}
                color={direction === 'long' ? '#2dff7a' : '#ff4d4d'}
              />
            </div>
            <span style={{ fontSize: 12, color: '#aaa' }}>
              mom {momentum.momentumStrength} · entry {momentum.entryQuality} · time {momentum.timingScore}
            </span>
          </div>
        </div>
      </div>

      <div
        style={{
          ...wfStyles.layerRow,
          background: '#0a0a14',
          border: `1px solid ${alignColor}55`,
          borderRadius: 10,
          padding: '12px 14px',
          marginTop: 4,
        }}
      >
        <div style={wfStyles.layerLabel}>Alignment</div>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <span
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 24,
                color: alignColor,
                fontWeight: 800,
                letterSpacing: '-0.5px',
                lineHeight: 1.1,
              }}
            >
              {alignment.timeframeAlignmentScore}/100
            </span>
            <Badge
              value={alignment.alignmentStatus.toUpperCase()}
              type={
                alignment.alignmentStatus === 'strong'
                  ? 'good'
                  : alignment.alignmentStatus === 'mixed'
                    ? 'warn'
                    : 'bad'
              }
            />
            <Badge value={`bias ${alignment.dominantBias}`} type="info" />
            {alignment.conflictingTimeframes.length > 0 && (
              <span style={{ fontSize: 13, color: '#ff8c00', fontFamily: "'JetBrains Mono', monospace" }}>
                ⚠ conflicts: {alignment.conflictingTimeframes.join(', ')}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const wfStyles: Record<string, React.CSSProperties> = {
  container: {
    background: '#0a0a14',
    border: '1px solid #181830',
    borderRadius: 10,
    padding: 14,
    marginBottom: 14,
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  timeframeRow: {
    display: 'flex',
    gap: 8,
    justifyContent: 'space-between',
    marginBottom: 4,
    flexWrap: 'wrap',
  },
  layerRow: {
    display: 'flex',
    gap: 14,
    alignItems: 'flex-start',
    padding: '6px 4px',
  },
  layerLabel: {
    fontSize: 12,
    color: '#888',
    fontFamily: "'JetBrains Mono', monospace",
    fontWeight: 700,
    letterSpacing: '0.6px',
    minWidth: 100,
    textTransform: 'uppercase',
    paddingTop: 2,
  },
};

// ─── Entry quality panel ──────────────────────────────────────────────────────

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
    default:
      return '#888';
  }
}

function EntryQualityRow({
  label,
  value,
  valueColor,
  sub,
}: {
  label: string;
  value: string;
  valueColor: string;
  sub?: string | null;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        padding: '8px 4px',
        borderTop: '1px solid #15152a',
      }}
    >
      <div
        style={{
          minWidth: 110,
          fontSize: 12,
          color: '#888',
          fontFamily: "'JetBrains Mono', monospace",
          fontWeight: 700,
          letterSpacing: '0.6px',
          textTransform: 'uppercase',
          paddingTop: 2,
        }}
      >
        {label}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 0 }}>
        <span
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 13,
            fontWeight: 700,
            color: valueColor,
          }}
        >
          {value}
        </span>
        {sub ? (
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: '#888', lineHeight: 1.45 }}>
            {sub}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function EntryQualityPanel({
  fibonacci,
  institutionalFlow,
  newsRisk,
  entryTiming,
  stopLossAnalysis,
}: {
  fibonacci?: FibonacciAnalysis;
  institutionalFlow?: InstitutionalFlow;
  newsRisk?: ForexNewsRisk;
  entryTiming?: EntryTiming;
  stopLossAnalysis?: StopLossAnalysis;
}) {
  if (!fibonacci && !institutionalFlow && !newsRisk && !entryTiming && !stopLossAnalysis) return null;

  const timingStatus = entryTiming?.status ?? 'unknown';
  const fibStatus = fibonacci?.entryZoneStatus ?? 'unknown';
  const flowDir = institutionalFlow?.direction ?? 'neutral';
  const newsLvl = newsRisk?.riskLevel ?? 'low';

  const fibValue = fibonacci?.timeframeUsed
    ? `${fibStatus.replace(/_/g, ' ')} · ${fibonacci.timeframeUsed} impulse ${fibonacci.impulsePips ?? '—'}p` +
      (fibonacci.pctRetraced != null ? ` · ${(fibonacci.pctRetraced * 100).toFixed(0)}% retraced` : '')
    : fibStatus.replace(/_/g, ' ');

  const flowValue = institutionalFlow?.detected
    ? `${institutionalFlow.type.replace(/_/g, ' ')} · ${flowDir}` +
      (institutionalFlow.confidenceImpact
        ? ` · ${institutionalFlow.confidenceImpact >= 0 ? '+' : ''}${institutionalFlow.confidenceImpact} conf`
        : '')
    : 'none detected';

  const newsValue = newsRisk
    ? `${newsLvl}${newsRisk.blocked ? ' · BLOCKED' : ''}${newsRisk.postNewsConfirmationRequired ? ' · post-news confirm' : ''}` +
      (newsRisk.matchingCurrencies?.length ? ` · ${newsRisk.matchingCurrencies.join('+')}` : '')
    : 'low';

  const slValue = stopLossAnalysis
    ? `${(stopLossAnalysis.structureSource ?? 'unknown').replace(/_/g, ' ')} · buf ${stopLossAnalysis.atrBuffer}p · @ ${stopLossAnalysis.finalStopLoss}`
    : '—';

  return (
    <div
      style={{
        background: '#0a0a14',
        border: '1px solid #181830',
        borderRadius: 10,
        padding: '4px 14px 10px 14px',
        marginBottom: 14,
      }}
    >
      <div
        style={{
          fontSize: 11,
          color: '#888',
          fontFamily: "'JetBrains Mono', monospace",
          fontWeight: 700,
          letterSpacing: '1px',
          textTransform: 'uppercase',
          padding: '10px 4px 4px 4px',
        }}
      >
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

// ─── Small layout cells (price / sizing / indicator) ──────────────────────────

function PriceCell({ label, value, color, sub }: { label: string; value: string; color: string; sub?: string }) {
  return (
    <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: '0.8px', fontWeight: 600 }}>
        {label}
      </div>
      <div
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 18,
          fontWeight: 700,
          color,
          lineHeight: 1.2,
        }}
      >
        {value}
      </div>
      {sub && <div style={{ fontSize: 11, color: '#888' }}>{sub}</div>}
    </div>
  );
}

function SizingCell({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: '0.7px', fontWeight: 600 }}>
        {label}
      </div>
      <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 15, color: '#e0e0ff', fontWeight: 700 }}>
        {value}
      </div>
    </div>
  );
}

function IndCell({ label, value, color = '#e0e0ff' }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: '0.7px', fontWeight: 600 }}>
        {label}
      </span>
      <span style={{ fontSize: 14, fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, color }}>{value}</span>
    </div>
  );
}

function IntradayCell({ label, value, color = '#e0e0ff' }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, textAlign: 'center' }}>
      <span style={{ fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: '0.6px', fontWeight: 600 }}>
        {label}
      </span>
      <span style={{ fontSize: 14, fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, color }}>{value}</span>
    </div>
  );
}

// ─── V3.5 liquidity-first analysis panel (shadow) ───────────────────────────

/** Short, ICT-style tag for a liquidity pool source ("Targeting PDH"). */
function liquidityTargetTag(source?: string | null): string | null {
  switch (source) {
    case 'PDH': return 'PDH';
    case 'PDL': return 'PDL';
    case 'PWH': return 'Weekly High';
    case 'PWL': return 'Weekly Low';
    case 'ASIA_H': return 'Asian High';
    case 'ASIA_L': return 'Asian Low';
    case 'LON_H': return 'London High';
    case 'LON_L': return 'London Low';
    case 'NY_H': return 'NY High';
    case 'NY_L': return 'NY Low';
    case 'PSESS_H': return 'Prev Session High';
    case 'PSESS_L': return 'Prev Session Low';
    case 'EQH': return 'Equal Highs';
    case 'EQL': return 'Equal Lows';
    case 'SWING_H': return 'Swing High';
    case 'SWING_L': return 'Swing Low';
    default: return null;
  }
}

function V3SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 10, color: '#6fae84', letterSpacing: '0.8px', textTransform: 'uppercase', fontWeight: 700 }}>
      {children}
    </div>
  );
}

function V3LiquidityPanel({ v3, pair, compact = false }: { v3: V3Meta; pair: string; compact?: boolean }) {
  const liq = v3.liquidity;
  const intent = v3.liquidityIntent;
  const pd = v3.premiumDiscount;
  const sn = v3.sessionNarrative;
  const targets = v3.targets;
  const muted: React.CSSProperties = { fontSize: 12, color: '#8a8aa0', fontFamily: "'JetBrains Mono', monospace" };
  // Keep each tier's own label and drop tiers that resolve to the same pool
  // (TP3 can equal TP1 when only one pool sits in the trade direction).
  const tiers: { name: string; t: NonNullable<NonNullable<typeof targets>['tp1']> }[] = [];
  const seenTierPrices = new Set<number>();
  for (const [name, t] of [['TP1', targets?.tp1], ['TP2', targets?.tp2], ['TP3', targets?.tp3]] as const) {
    if (t && !seenTierPrices.has(t.price)) { seenTierPrices.add(t.price); tiers.push({ name, t }); }
  }

  const pdPenalty = pd?.entryQualityPenalty ?? 0;
  const pdBadge: BadgeType = !pd?.enabled ? 'neutral' : pdPenalty === 0 ? 'good' : pdPenalty < 0.5 ? 'warn' : 'bad';
  const pdMarkerColor = pdPenalty === 0 ? '#2dff7a' : pdPenalty < 0.5 ? '#ffcc00' : '#ff4d4d';

  // Compact form for rejected rows — keeps the shadow intelligence visible
  // without the full panel's bars/grids.
  if (compact) {
    return (
      <div
        style={{
          background: '#0a0f0a',
          border: '1px solid #15281a',
          borderRadius: 8,
          padding: '8px 12px',
          marginTop: 10,
          display: 'flex',
          flexDirection: 'column',
          gap: 5,
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 12,
        }}
      >
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ color: '#7CFFA0', fontWeight: 700, letterSpacing: '0.4px' }}>V3.5 shadow</span>
          <span style={{ color: '#888' }}>
            score {v3.score}/100{v3.direction ? ` · ${v3.direction.toUpperCase()}` : ''}{v3.earlyTrigger ? ' · early trigger' : ''}
          </span>
          {liq.sweepDetected && (
            <Badge type={liq.sweepDirection === 'bullish' ? 'good' : 'bad'} value={`Swept ${liq.sweptLiquidity ?? 'liquidity'}`} />
          )}
          {pd?.enabled && pd.premiumDiscountState !== 'unknown' && (
            <Badge type={pdBadge} value={pd.premiumDiscountState.toUpperCase()} />
          )}
        </div>
        {sn?.sessionNarrative && <div style={{ color: '#cfe9d6' }}>{sn.sessionNarrative}</div>}
        {intent?.expectedLiquidityTarget && (
          <div style={{ color: '#8a8aa0' }}>
            Draw → {intent.expectedLiquidityTarget.label} ({intent.expectedLiquidityTarget.distancePips}p)
          </div>
        )}
        {tiers.length > 0 && (
          <div style={{ color: '#8a8aa0' }}>
            Targets: {tiers.map(({ name, t }) => `${name} ${liquidityTargetTag(t.source) ?? t.label}`).join(' · ')}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      style={{
        background: '#0a0f0a',
        border: '1px solid #1d3320',
        borderRadius: 10,
        padding: 14,
        marginBottom: 14,
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: '#7CFFA0', letterSpacing: '0.6px', textTransform: 'uppercase' }}>
          V3.5 Liquidity Analysis
        </span>
        <span style={{ fontSize: 10, color: '#888', fontFamily: "'JetBrains Mono', monospace" }}>
          shadow · score {v3.score}/100{v3.earlyTrigger ? ' · early trigger' : ''}
          {v3.direction ? ` · ${v3.direction.toUpperCase()}` : ''}
        </span>
      </div>

      {/* LIQUIDITY TARGETS */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <V3SectionTitle>Liquidity Targets</V3SectionTitle>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', ...muted }}>
          <span>
            <span style={{ color: '#666' }}>Above: </span>
            {liq.nearestLiquidityAbove
              ? `${liq.nearestLiquidityAbove.label} @ ${formatPrice(liq.nearestLiquidityAbove.price, pair)} (${liq.nearestLiquidityAbove.distancePips}p)`
              : '—'}
          </span>
          <span>
            <span style={{ color: '#666' }}>Below: </span>
            {liq.nearestLiquidityBelow
              ? `${liq.nearestLiquidityBelow.label} @ ${formatPrice(liq.nearestLiquidityBelow.price, pair)} (${liq.nearestLiquidityBelow.distancePips}p)`
              : '—'}
          </span>
        </div>
        {tiers.length > 0 && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {tiers.map(({ name, t }) => (
              <Badge
                key={name}
                type={t.major ? 'good' : 'info'}
                value={`${name} → ${liquidityTargetTag(t.source) ?? t.label} (${Math.abs(t.pips)}p)`}
              />
            ))}
          </div>
        )}
      </div>

      {/* LIQUIDITY EVENTS (sweeps) */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <V3SectionTitle>Liquidity Events</V3SectionTitle>
        {liq.sweepDetected ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Badge
              type={liq.sweepDirection === 'bullish' ? 'good' : 'bad'}
              value={`✓ Swept ${liq.sweptLiquidity ?? 'liquidity'} (${liq.sweepDirection})`}
            />
            {liq.sweepStrength != null && <span style={muted}>strength {(liq.sweepStrength * 100).toFixed(0)}%</span>}
          </div>
        ) : (
          <span style={muted}>No liquidity sweep this scan.</span>
        )}
      </div>

      {/* PREMIUM / DISCOUNT */}
      {pd?.enabled && pd.pricePositionPct != null && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <V3SectionTitle>Premium / Discount</V3SectionTitle>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Badge type={pdBadge} value={pd.premiumDiscountState.toUpperCase()} />
            <div style={{ flex: 1 }}>
              <div style={{ position: 'relative', height: 10, background: '#1a1a2e', borderRadius: 5 }}>
                <div style={{ position: 'absolute', left: '50%', top: -2, bottom: -2, width: 1, background: '#555' }} />
                <div
                  style={{
                    position: 'absolute',
                    left: `${Math.max(0, Math.min(100, pd.pricePositionPct * 100))}%`,
                    top: -3,
                    width: 3,
                    height: 16,
                    background: pdMarkerColor,
                    borderRadius: 2,
                    transform: 'translateX(-50%)',
                  }}
                />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: '#666', marginTop: 3 }}>
                <span>Discount</span>
                <span>Equilibrium</span>
                <span>Premium</span>
              </div>
            </div>
            <span style={{ ...muted, minWidth: 36, textAlign: 'right' }}>{(pd.pricePositionPct * 100).toFixed(0)}%</span>
          </div>
          {pdPenalty > 0 && <div style={{ fontSize: 11, color: '#ffaa00' }}>⚠ {pd.reason}</div>}
        </div>
      )}

      {/* SESSION NARRATIVE */}
      {sn && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <V3SectionTitle>Session Narrative</V3SectionTitle>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, color: '#cfe9d6', fontFamily: "'JetBrains Mono', monospace" }}>
              {sn.sessionNarrative}
            </span>
            <span style={muted}>
              {sn.sessionBias} · conf {(sn.sessionConfidence * 100).toFixed(0)}%
            </span>
          </div>
        </div>
      )}

      {/* STOP TARGET ANALYSIS */}
      {intent && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <V3SectionTitle>Stop Target Analysis</V3SectionTitle>
          <div style={{ ...muted, display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span>
              <span style={{ color: '#666' }}>Liquidity above: </span>
              {intent.likelyStopsAbove.length
                ? intent.likelyStopsAbove.slice(0, 3).map((p) => p.label).join(', ')
                : '—'}
            </span>
            <span>
              <span style={{ color: '#666' }}>Liquidity below: </span>
              {intent.likelyStopsBelow.length
                ? intent.likelyStopsBelow.slice(0, 3).map((p) => p.label).join(', ')
                : '—'}
            </span>
            <span>
              <span style={{ color: '#666' }}>Bias / draw: </span>
              <span style={{ color: trendColor(intent.liquidityBias) }}>{intent.liquidityBias}</span>
              {intent.expectedLiquidityTarget
                ? ` → ${intent.expectedLiquidityTarget.label} (${intent.expectedLiquidityTarget.distancePips}p)`
                : ''}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Qualified signal card ────────────────────────────────────────────────────

type TradeOutcome =
  | { state: 'idle' }
  | { state: 'pending' }
  | { state: 'success'; tradeId?: string; fillPrice?: number; units?: number; reason?: string | null }
  | { state: 'blocked'; reason: string }
  | { state: 'error'; reason: string };

function SignalCard({
  signal,
  executionEnabled,
  executionBlockerReason,
  isPaper,
}: {
  signal: ForexSignal;
  executionEnabled: boolean;
  executionBlockerReason: string | null;
  isPaper: boolean;
}) {
  const isLong = signal.direction === 'long';
  const isMetal = signal.assetClass === 'Metal';
  const confColor = signal.confidence >= 60 ? '#2dff7a' : signal.confidence >= 30 ? '#ffcc00' : '#ff8c00';
  const pairDisplay = displayPair(signal.pair);
  const [outcome, setOutcome] = useState<TradeOutcome>({ state: 'idle' });

  const executeTrade = useCallback(async () => {
    setOutcome({ state: 'pending' });
    try {
      const res = await fetch('/api/scanner/trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signal }),
      });
      const json = await res.json();
      if (!res.ok || !json?.ok) {
        setOutcome({ state: 'error', reason: json?.error || `HTTP ${res.status}` });
        return;
      }
      const trade = (json.trade ?? {}) as {
        success?: boolean;
        blocked?: boolean;
        reason?: string | null;
        tradeId?: string;
        fillPrice?: number;
        units?: number;
      };
      if (trade.blocked) {
        setOutcome({ state: 'blocked', reason: trade.reason || 'Trade blocked by Railway guard' });
      } else if (trade.success) {
        setOutcome({
          state: 'success',
          tradeId: trade.tradeId,
          fillPrice: trade.fillPrice,
          units: trade.units,
          reason: trade.reason,
        });
      } else {
        setOutcome({ state: 'error', reason: trade.reason || 'Trade execution failed' });
      }
    } catch (err) {
      setOutcome({ state: 'error', reason: err instanceof Error ? err.message : String(err) });
    }
  }, [signal]);

  return (
    <div style={{ ...s.card, borderColor: isMetal ? '#3d2a00' : '#1e1e30' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14, gap: 16 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
            <span
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontWeight: 800,
                fontSize: 22,
                color: isMetal ? '#ffaa00' : '#e0e0ff',
              }}
            >
              {pairDisplay}
            </span>
            <Badge value={isLong ? 'BUY' : 'SELL'} type={isLong ? 'good' : 'bad'} />
            <Badge value={isLong ? 'LONG' : 'SHORT'} type={isLong ? 'good' : 'bad'} />
            <Badge value={signal.assetClass} type={isMetal ? 'metal' : 'neutral'} />
          </div>
          <div style={{ fontSize: 13, color: '#888', fontFamily: "'JetBrains Mono', monospace" }}>
            {signal.instrumentName}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 28, color: confColor, fontWeight: 800, lineHeight: 1.1 }}>
            {signal.confidence}%
          </div>
          <div style={{ fontSize: 11, color: '#888', marginTop: 4, textTransform: 'uppercase', letterSpacing: '1px', fontWeight: 600 }}>
            confidence
          </div>
        </div>
      </div>

      {/* Session + duration + RR tier */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <Badge value={signal.session} type="info" />
        <Badge
          value={signal.tradeDuration}
          type={signal.tradeDuration === 'Intraday' ? 'good' : signal.tradeDuration === 'Scalp' ? 'warn' : 'neutral'}
        />
        {signal.rrTier && (
          <Badge
            value={signal.rrTier.toUpperCase()}
            type={
              signal.rrTier === 'premium'
                ? 'good'
                : signal.rrTier === 'preferred'
                  ? 'info'
                  : signal.rrTier === 'standard'
                    ? 'warn'
                    : 'bad'
            }
          />
        )}
        {signal.expectedRR !== undefined && (
          <span
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 13,
              color: '#aaa',
              fontWeight: 600,
            }}
          >
            Expected RR: <span style={{ color: '#4db8ff' }}>{signal.expectedRR}</span>
            {signal.expectedRiskPips !== undefined && signal.expectedRewardPips !== undefined && (
              <span style={{ color: '#666' }}>
                {' '}
                · risk {signal.expectedRiskPips}p · reward {signal.expectedRewardPips}p
              </span>
            )}
          </span>
        )}
      </div>

      {/* Waterfall */}
      {signal.macro && signal.structure && signal.momentum && signal.alignment && (
        <WaterfallPanel
          macro={signal.macro}
          structure={signal.structure}
          momentum={signal.momentum}
          alignment={signal.alignment}
          direction={signal.direction}
        />
      )}

      {/* Entry quality */}
      <EntryQualityPanel
        fibonacci={signal.fibonacci}
        institutionalFlow={signal.institutionalFlow}
        newsRisk={signal.newsRisk}
        entryTiming={signal.entryTiming}
        stopLossAnalysis={signal.stopLossAnalysis}
      />

      {/* Intraday intel */}
      <div style={s.intradayGrid}>
        <IntradayCell
          label="Hold Time"
          value={`~${signal.estimatedHoldMinutes}m`}
          color={signal.tradeDuration === 'Intraday' ? '#2dff7a' : signal.tradeDuration === 'Scalp' ? '#ffcc00' : '#888'}
        />
        <IntradayCell
          label="Volatility"
          value={signal.volatilityState}
          color={
            signal.volatilityState === 'expanding' ? '#2dff7a' : signal.volatilityState === 'normal' ? '#ffcc00' : '#ff4d4d'
          }
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
        {signal.expectedMovementPips !== null && signal.expectedMovementPips !== undefined && (
          <IntradayCell label="Exp Move" value={`${signal.expectedMovementPips}p`} color="#4db8ff" />
        )}
      </div>

      {/* Price levels */}
      <div style={s.priceGrid}>
        <PriceCell label="Entry" value={formatPrice(signal.entry, signal.pair)} color="#e0e0ff" />
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
          sub={`${(signal.takeProfitPips ?? signal.stopLossPips * signal.riskReward).toFixed(0)} pips${
            liquidityTargetTag(signal.v3?.targets?.tp1?.source)
              ? ` · → ${liquidityTargetTag(signal.v3?.targets?.tp1?.source)}`
              : ''
          }`}
        />
        <PriceCell
          label="Risk / Reward"
          value={`1 : ${signal.riskReward}`}
          color={signal.riskReward >= 3 ? '#2dff7a' : '#ffcc00'}
        />
      </div>

      {/* V3.5 liquidity-first analysis (shadow) */}
      {signal.v3 && signal.v3.mode !== 'off' && <V3LiquidityPanel v3={signal.v3} pair={signal.pair} />}

      {/* Per-trade risk */}
      {(signal.targetRiskUSD !== undefined ||
        signal.actualRiskUSD !== undefined ||
        signal.estimatedRewardUSD !== undefined ||
        signal.estimatedMarginRequired !== undefined ||
        signal.effectiveLeverage !== undefined) && (
        <div style={s.riskGrid}>
          <SizingCell label="Risk %" value={signal.riskPercent !== undefined ? `${signal.riskPercent.toFixed(2)}%` : '—'} />
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

      {/* Sizing */}
      <div style={s.sizingGrid}>
        <SizingCell label="Lot Size" value={signal.lotSize.toFixed(4)} />
        <SizingCell label="Units" value={formatUnits(signal.tradeUnits)} />
        <SizingCell label="Notional" value={formatAmount(signal.amountTraded)} />
        <SizingCell label="R:R" value={`1 : ${signal.riskReward.toFixed(2)}`} />
        <SizingCell label="Spread" value={`${signal.spreadPips.toFixed(1)} pip`} />
      </div>

      {/* Lifecycle reasoning */}
      {signal.lifecycle && (
        <div style={s.factorsBox}>
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
              <span style={{ color: '#2dff7a', fontWeight: 700 }}>
                {((signal.tpProbability ?? 0) * 100).toFixed(0)}%
              </span>
              {' · '}
              <span style={{ color: '#888' }}>SL prob:</span>{' '}
              <span style={{ color: '#ff6666', fontWeight: 700 }}>
                {((signal.slProbability ?? 0) * 100).toFixed(0)}%
              </span>
              {signal.cappedByKeyLevel && (
                <span style={{ marginLeft: 8, color: '#ffaa00' }}>
                  ⚠ TP capped by H4 key level @ {signal.keyLevelDistance}p
                </span>
              )}
              {signal.cappedByAtr && <span style={{ marginLeft: 8, color: '#ffaa00' }}>⚠ TP capped by ATR realism</span>}
            </div>
          </div>
        </div>
      )}

      {/* Sizing modifiers */}
      {signal.riskSizingFactors?.modifiers && signal.riskSizingFactors.modifiers.length > 0 && (
        <div style={s.factorsBox}>
          <span style={{ color: '#888' }}>Sizing modifiers:</span>{' '}
          <span style={{ color: '#4db8ff' }}>{signal.riskSizingFactors.modifiers.join(' · ')}</span>
        </div>
      )}

      {/* Sizing warnings */}
      {signal.sizingWarnings && signal.sizingWarnings.length > 0 && (
        <div style={s.warnBox}>
          {signal.sizingWarnings.map((w, i) => (
            <div key={i}>⚠ {w}</div>
          ))}
        </div>
      )}

      {/* Alignment score */}
      <div style={{ marginBottom: 14 }}>
        <div
          style={{
            fontSize: 12,
            color: '#888',
            marginBottom: 6,
            textTransform: 'uppercase',
            letterSpacing: '0.8px',
            fontWeight: 600,
          }}
        >
          Timeframe Alignment Score
        </div>
        <ScoreBar score={signal.score} max={100} minScore={55} />
      </div>

      {/* Indicators */}
      <div style={s.indicatorRow}>
        {signal.rsi !== null && signal.rsi !== undefined && (
          <IndCell
            label="RSI"
            value={signal.rsi.toFixed(1)}
            color={signal.rsi > 70 ? '#ff4d4d' : signal.rsi < 30 ? '#4db8ff' : '#e0e0ff'}
          />
        )}
        {signal.macd && (
          <IndCell
            label="MACD"
            value={`${signal.macd.histogram > 0 ? '▲' : '▼'} ${Math.abs(signal.macd.histogram).toFixed(5)}`}
            color={signal.macd.histogram > 0 ? '#2dff7a' : '#ff4d4d'}
          />
        )}
        {signal.atrPips !== null && signal.atrPips !== undefined && (
          <IndCell label="ATR" value={`${signal.atrPips.toFixed(1)}p`} color="#e0e0ff" />
        )}
        <IndCell
          label="Trend"
          value={signal.trend}
          color={signal.trend === 'bullish' ? '#2dff7a' : signal.trend === 'bearish' ? '#ff4d4d' : '#888'}
        />
        <IndCell
          label="Candle"
          value={signal.candleConfirmation}
          color={
            signal.candleConfirmation === 'bullish'
              ? '#2dff7a'
              : signal.candleConfirmation === 'bearish'
                ? '#ff4d4d'
                : '#888'
          }
        />
      </div>

      {/* Score breakdown */}
      <details style={{ marginTop: 12 }}>
        <summary style={{ cursor: 'pointer', color: '#888', fontSize: 13, fontWeight: 600 }}>Score breakdown</summary>
        <div style={s.breakdownGrid}>
          {Object.entries(signal.scoreBreakdown).map(([key, val]) => (
            <div
              key={key}
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0' }}
            >
              <span style={{ color: '#aaa', fontSize: 13, textTransform: 'capitalize' }}>
                {key.replace(/([A-Z])/g, ' $1').trim()}
              </span>
              <Badge value={`${val}/2`} type={val === 2 ? 'good' : val === 1 ? 'warn' : 'neutral'} />
            </div>
          ))}
        </div>
      </details>

      {/* Execute Trade — only when the user is in live mode with all gates
          passing. In any other state the button is replaced by an inline
          blocker that explains why so the user can act on it. */}
      <div style={{ marginTop: 18 }}>
        {executionEnabled ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button
              type="button"
              onClick={executeTrade}
              disabled={outcome.state === 'pending' || outcome.state === 'success'}
              style={{
                padding: '12px 24px',
                background:
                  outcome.state === 'success'
                    ? 'linear-gradient(135deg, #0d3320, #1a5c38)'
                    : 'linear-gradient(135deg, #401400, #5c1a1a)',
                color: outcome.state === 'success' ? '#2dff7a' : '#ffaa66',
                border: outcome.state === 'success' ? '1px solid #2dff7a' : '1px solid #ff6633',
                borderRadius: 8,
                fontFamily: 'inherit',
                fontWeight: 800,
                fontSize: 14,
                letterSpacing: '0.5px',
                textTransform: 'uppercase',
                cursor:
                  outcome.state === 'pending' || outcome.state === 'success' ? 'not-allowed' : 'pointer',
                width: 'fit-content',
              }}
            >
              {outcome.state === 'pending'
                ? 'Executing…'
                : outcome.state === 'success'
                  ? '✓ Trade executed'
                  : isPaper
                    ? 'Execute Paper Trade'
                    : `Execute ${isLong ? 'BUY' : 'SELL'} (LIVE)`}
            </button>
            {outcome.state === 'success' && (
              <div style={tradeBoxStyle('good')}>
                <strong>Filled.</strong> tradeId {outcome.tradeId ?? '—'} · fill{' '}
                {outcome.fillPrice != null ? outcome.fillPrice : '—'} · {outcome.units ?? '—'} units
              </div>
            )}
            {outcome.state === 'blocked' && (
              <div style={tradeBoxStyle('warn')}>
                <strong>Blocked by safety guard:</strong> {outcome.reason}
              </div>
            )}
            {outcome.state === 'error' && (
              <div style={tradeBoxStyle('bad')}>
                <strong>Execution error:</strong> {outcome.reason}
              </div>
            )}
          </div>
        ) : (
          <div style={tradeBoxStyle('warn')}>
            <strong>Execution unavailable.</strong>{' '}
            {executionBlockerReason || 'Connect a broker for this mode to execute trades.'}
          </div>
        )}
      </div>

      <div style={{ marginTop: 14, fontSize: 12, color: '#666', fontFamily: "'JetBrains Mono', monospace" }}>
        generated {new Date(signal.generatedAt).toLocaleTimeString()}
      </div>
    </div>
  );
}

// ─── Close-trade button + confirmation modal ────────────────────────────────

type CloseMode = 'close' | 'partial_close';

type CloseResult = {
  ok: boolean;
  action?: 'closed' | 'partial_closed';
  instrument?: string | null;
  unitsClosed?: number;
  brokerOrderId?: string | null;
  pnl?: number | null;
  message?: string;
  error?: string;
};

function CloseTradeButton({
  tradeId,
  instrument,
  totalUnits,
  unrealizedPL,
  direction,
  mode,
  partialPercent,
  reason,
  isLive,
  onAfter,
}: {
  tradeId: string;
  instrument: string;
  totalUnits: number;
  unrealizedPL?: number | null;
  direction?: 'long' | 'short';
  mode: CloseMode;
  partialPercent?: number;
  reason: string;
  isLive: boolean;
  onAfter: () => Promise<void> | void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<CloseResult | null>(null);

  // Partial unit count rounded down to a whole-unit minimum of 1.
  const unitsForRequest =
    mode === 'partial_close' && partialPercent && partialPercent > 0
      ? Math.max(1, Math.floor((totalUnits * partialPercent) / 100))
      : null;

  const buttonLabel =
    mode === 'close'
      ? 'Close Trade'
      : `Close ${partialPercent ?? 25}% (~${unitsForRequest ?? '?'} units)`;

  const buttonTone: 'bad' | 'warn' = mode === 'close' ? 'bad' : 'warn';

  const execute = async () => {
    setPending(true);
    setResult(null);
    try {
      const res = await fetch('/api/scanner/close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tradeId,
          instrument,
          units: mode === 'partial_close' ? unitsForRequest ?? undefined : 'ALL',
        }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string; close?: CloseResult };
      if (!res.ok || !json?.ok) {
        setResult({ ok: false, error: json?.error || `HTTP ${res.status}` });
      } else {
        setResult({ ok: true, ...(json.close ?? {}) });
        // Refresh parent's active trades + reassess view.
        try {
          await onAfter();
        } catch {
          /* parent-side refresh failure is non-fatal */
        }
      }
    } catch (err) {
      setResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setResult(null);
          setConfirming(true);
        }}
        disabled={pending || result?.ok === true}
        style={{
          padding: '8px 16px',
          background: buttonTone === 'bad' ? '#320d0d' : '#2d1f00',
          color: buttonTone === 'bad' ? '#ff8888' : '#ffcc66',
          border: buttonTone === 'bad' ? '1px solid #ff4d4d' : '1px solid #ff8c00',
          borderRadius: 6,
          fontFamily: 'inherit',
          fontWeight: 700,
          fontSize: 13,
          cursor: pending || result?.ok ? 'not-allowed' : 'pointer',
          letterSpacing: '0.3px',
        }}
      >
        {result?.ok
          ? mode === 'close'
            ? '✓ Closed'
            : '✓ Partial closed'
          : pending
            ? 'Submitting…'
            : buttonLabel}
      </button>

      {/* Inline post-execution status — keeps the modal closed once the user
          has acted on it. */}
      {result && !confirming && (
        <span
          style={{
            marginLeft: 10,
            fontSize: 12,
            color: result.ok ? '#2dff7a' : '#ff8888',
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          }}
        >
          {result.ok
            ? `${result.action === 'partial_closed' ? `${result.unitsClosed ?? '?'} units · ` : ''}` +
              (result.pnl != null ? `pnl $${result.pnl.toFixed(2)} · ` : '') +
              `order ${result.brokerOrderId ?? '—'}`
            : `Failed: ${result.error}`}
        </span>
      )}

      {/* Confirmation modal */}
      {confirming && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={(e) => {
            if (e.target === e.currentTarget && !pending) setConfirming(false);
          }}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
        >
          <div
            style={{
              background: 'var(--panel)',
              border: `1px solid ${buttonTone === 'bad' ? '#5c1a1a' : '#5c4400'}`,
              borderRadius: 10,
              padding: 24,
              maxWidth: 500,
              width: 'calc(100% - 32px)',
              boxShadow: '0 10px 30px rgba(0,0,0,0.4)',
            }}
          >
            <h3 style={{ margin: 0, fontSize: 18, color: buttonTone === 'bad' ? '#ff8888' : '#ffcc66' }}>
              {mode === 'close' ? 'Confirm trade close' : 'Confirm partial close'}
            </h3>

            <div style={{ marginTop: 14, display: 'grid', gap: 8, fontSize: 13 }}>
              <Row label="Instrument" value={instrument} />
              {direction && <Row label="Direction" value={direction.toUpperCase()} />}
              {unrealizedPL != null && (
                <Row
                  label="Unrealized P/L"
                  value={`$${unrealizedPL.toFixed(2)}`}
                  valueColor={unrealizedPL >= 0 ? '#2dff7a' : '#ff6666'}
                />
              )}
              <Row label="Total units on trade" value={String(totalUnits)} />
              <Row
                label="Units to close"
                value={mode === 'close' ? 'ALL' : `${unitsForRequest ?? '?'} (${partialPercent ?? 25}%)`}
                valueColor={buttonTone === 'bad' ? '#ff8888' : '#ffcc66'}
              />
              <Row label="Recommended action" value={mode === 'close' ? 'CLOSE' : 'PARTIAL CLOSE'} />
            </div>

            {reason && (
              <div
                style={{
                  marginTop: 12,
                  padding: '8px 12px',
                  background: 'var(--bg)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  fontSize: 12,
                  color: 'var(--muted)',
                  lineHeight: 1.5,
                }}
              >
                <strong style={{ color: 'var(--text)' }}>Reason:</strong> {reason}
              </div>
            )}

            <div
              style={{
                marginTop: 14,
                padding: '10px 12px',
                background: isLive ? '#320d0d' : '#1a1a2e',
                border: isLive ? '1px solid #5c1a1a' : '1px solid #2a2a4a',
                borderRadius: 6,
                fontSize: 13,
                color: isLive ? '#ff8888' : 'var(--muted)',
              }}
            >
              <strong>{isLive ? '⚠ LIVE: ' : 'Paper mode: '}</strong>
              {isLive
                ? 'This will send a live order to OANDA and may affect real funds.'
                : 'This will send the close request to your OANDA practice account.'}
            </div>

            {result && !result.ok && (
              <div
                style={{
                  marginTop: 12,
                  padding: '8px 12px',
                  background: '#320d0d',
                  border: '1px solid #5c1a1a',
                  color: '#ff8888',
                  borderRadius: 6,
                  fontSize: 13,
                }}
              >
                <strong>Error:</strong> {result.error}
              </div>
            )}

            <div style={{ marginTop: 16, display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={pending}
                style={{
                  padding: '8px 16px',
                  background: 'var(--bg)',
                  color: 'var(--text)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  fontFamily: 'inherit',
                  fontWeight: 600,
                  fontSize: 13,
                  cursor: pending ? 'not-allowed' : 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={async () => {
                  await execute();
                  if (result?.ok || !confirming) setConfirming(false);
                }}
                disabled={pending}
                style={{
                  padding: '8px 16px',
                  background: buttonTone === 'bad' ? '#5c1a1a' : '#5c4400',
                  color: buttonTone === 'bad' ? '#ffaaaa' : '#ffdd99',
                  border: buttonTone === 'bad' ? '1px solid #ff4d4d' : '1px solid #ff8c00',
                  borderRadius: 6,
                  fontFamily: 'inherit',
                  fontWeight: 800,
                  fontSize: 13,
                  cursor: pending ? 'wait' : 'pointer',
                  letterSpacing: '0.5px',
                }}
              >
                {pending ? 'Submitting…' : mode === 'close' ? 'Confirm close' : 'Confirm partial close'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Row({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
      <span style={{ color: 'var(--muted)' }}>{label}</span>
      <span
        style={{
          color: valueColor ?? 'var(--text)',
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          fontWeight: 600,
        }}
      >
        {value}
      </span>
    </div>
  );
}

/**
 * Convert a recommendation (from lifecycle engine or classic reassess) into the
 * close-button mode + partial percent. Returns null when no execution applies
 * (hold / SL-move / TP-adjust recommendations).
 */
function deriveCloseMode(args: {
  lifecycleAction?: string;
  classicAction?: string;
  classicExitRecommendation?: string;
  shouldAutoClose?: boolean;
  partialPercent?: number | null;
  defaultPartialPercent?: number;
}): { mode: CloseMode; partialPercent: number } | null {
  const a = (args.lifecycleAction ?? '').toLowerCase();
  const c = (args.classicAction ?? '').toUpperCase();
  const exitRec = (args.classicExitRecommendation ?? '').toUpperCase();

  // Hard close paths.
  if (
    a === 'close' ||
    args.shouldAutoClose === true ||
    c.startsWith('EXIT') ||
    exitRec === 'CLOSE_TRADE' ||
    exitRec === 'CLOSE_IMMEDIATELY'
  ) {
    return { mode: 'close', partialPercent: 100 };
  }
  // Partial paths.
  if (
    a === 'partial_close' ||
    c === 'PARTIAL_EXIT' ||
    exitRec === 'TAKE_PARTIAL_PROFIT'
  ) {
    const pct =
      args.partialPercent && args.partialPercent > 0 && args.partialPercent <= 100
        ? args.partialPercent
        : args.defaultPartialPercent ?? 25;
    return { mode: 'partial_close', partialPercent: pct };
  }
  return null;
}

function tradeBoxStyle(tone: 'good' | 'warn' | 'bad'): React.CSSProperties {
  const palette: Record<'good' | 'warn' | 'bad', { bg: string; bd: string; fg: string }> = {
    good: { bg: '#0d3320', bd: '#1a5c38', fg: '#2dff7a' },
    warn: { bg: '#2d1f00', bd: '#5c4400', fg: '#ffcc66' },
    bad:  { bg: '#320d0d', bd: '#5c1a1a', fg: '#ff8888' },
  };
  const c = palette[tone];
  return {
    padding: '10px 14px',
    background: c.bg,
    border: `1px solid ${c.bd}`,
    color: c.fg,
    borderRadius: 8,
    fontSize: 13,
    lineHeight: 1.5,
  };
}

// ─── Rejected row ─────────────────────────────────────────────────────────────

function RejectedRow({ sig }: { sig: ForexRejected }) {
  const pairDisplay = displayPair(sig.pair);
  const reasons =
    sig.rejectionReasons && sig.rejectionReasons.length > 0 ? sig.rejectionReasons : sig.reason ? [sig.reason] : [];

  const alignObj =
    typeof sig.alignment === 'object' && sig.alignment !== null ? (sig.alignment as AlignmentResult) : null;

  return (
    <div style={s.rejectedRow}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 800, fontSize: 18, color: '#aaa' }}>
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
        {alignObj && <Badge value={`align ${alignObj.timeframeAlignmentScore}/100`} type="info" />}
        {sig.rejectionCategory === 'news_blocked' && <Badge value="NEWS BLOCKED" type="bad" />}
        {sig.rejectionCategory === 'flow_opposes' && <Badge value="FLOW OPPOSES" type="bad" />}
        {sig.entryTiming && sig.entryTiming.status !== 'valid_entry' && (
          <Badge value={sig.entryTiming.status.replace(/_/g, ' ').toUpperCase()} type="warn" />
        )}
      </div>

      {(sig.fibonacci || sig.institutionalFlow || sig.newsRisk || sig.entryTiming) && (
        <EntryQualityPanel
          fibonacci={sig.fibonacci}
          institutionalFlow={sig.institutionalFlow}
          newsRisk={sig.newsRisk}
          entryTiming={sig.entryTiming}
          stopLossAnalysis={undefined}
        />
      )}

      {alignObj && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          {(['daily', 'h4', 'h1', 'm30', 'm15', 'm5'] as const).map((tf) => (
            <TimeframePill key={tf} tf={tf.toUpperCase()} trend={alignObj.timeframes[tf]} />
          ))}
          {alignObj.conflictingTimeframes.length > 0 && (
            <span style={{ fontSize: 13, color: '#ff8c00', fontFamily: "'JetBrains Mono', monospace" }}>
              ⚠ conflicts: {alignObj.conflictingTimeframes.join(', ')}
            </span>
          )}
        </div>
      )}

      <div style={{ fontSize: 13, color: '#cc4444', marginBottom: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {reasons.map((r, i) => (
          <div key={i} style={{ display: 'flex', gap: 8 }}>
            <span style={{ color: '#ff4d4d', fontWeight: 700 }}>✗</span>
            <span>{r}</span>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 13, fontFamily: "'JetBrains Mono', monospace" }}>
        {sig.confidence !== undefined && <span style={{ color: '#ff8888' }}>Conf: {sig.confidence}%</span>}
        {sig.spreadPips !== undefined && <span style={{ color: '#ff8c00' }}>Spread: {sig.spreadPips.toFixed(1)}p</span>}
        {sig.session && <span style={{ color: '#888' }}>{sig.session}</span>}
        {sig.macro && (
          <span style={{ color: '#aaa' }}>
            macro conf {sig.macro.macroConfidence} · regime {sig.macro.volatilityRegime}
          </span>
        )}
      </div>

      {/* V3.5 liquidity-first analysis (shadow, diagnostic only — never promotes) */}
      {sig.v3 && sig.v3.mode !== 'off' && <V3LiquidityPanel v3={sig.v3} pair={sig.pair} compact />}
    </div>
  );
}

// ─── Active trade card ────────────────────────────────────────────────────────

const STATE_COLOR: Record<string, { fg: string; bg: string; bd: string }> = {
  OPEN_HEALTHY: { fg: '#2dff7a', bg: '#0d3320', bd: '#1a5c38' },
  ACCELERATING: { fg: '#2dff7a', bg: '#0d3320', bd: '#1a5c38' },
  TP_LIKELY: { fg: '#2dff7a', bg: '#0d3320', bd: '#1a5c38' },
  STALLING: { fg: '#ffcc00', bg: '#2d2200', bd: '#5c4600' },
  WEAKENING: { fg: '#ffcc00', bg: '#2d2200', bd: '#5c4600' },
  REVERSAL_RISK: { fg: '#ff8c00', bg: '#2d1100', bd: '#7a3200' },
  EXIT_RECOMMENDED: { fg: '#ff4d4d', bg: '#320d0d', bd: '#5c1a1a' },
  INVALIDATED: { fg: '#ff4d4d', bg: '#320d0d', bd: '#5c1a1a' },
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

function ActiveTradeCard({
  trade,
  onAfterClose,
  isLive,
}: {
  trade: ActiveTradeAnalysis;
  onAfterClose: () => Promise<void> | void;
  isLive: boolean;
}) {
  if (trade.error) {
    return (
      <div style={{ ...s.card, borderColor: '#5c1a1a' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 800, fontSize: 18 }}>
            {displayPair(trade.instrument)}
          </span>
          <Badge value="ERROR" type="bad" />
        </div>
        <div style={{ marginTop: 10, color: '#ff8c00', fontSize: 13 }}>Analysis failed: {trade.error}</div>
      </div>
    );
  }

  const stateStyle = STATE_COLOR[trade.tradeState] || STATE_COLOR.OPEN_HEALTHY;
  const recType = REC_COLOR[trade.exitRecommendation] || 'neutral';
  const isLong = trade.side === 'long';
  const plColor = trade.unrealizedPL >= 0 ? '#2dff7a' : '#ff4d4d';
  const decayColor =
    trade.timeDecayRisk === 'low' ? '#2dff7a' : trade.timeDecayRisk === 'medium' ? '#ffcc00' : '#ff8c00';

  return (
    <div
      style={{
        ...s.card,
        borderColor: stateStyle.bd,
        borderLeftWidth: 4,
        borderLeftStyle: 'solid',
        borderLeftColor: stateStyle.fg,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12, gap: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 800, fontSize: 20 }}>
              {displayPair(trade.instrument)}
            </span>
            <Badge value={isLong ? 'LONG' : 'SHORT'} type={isLong ? 'good' : 'bad'} />
            <Badge value={trade.tradeState} type="neutral" />
            <Badge value={`→ ${trade.exitRecommendation}`} type={recType} />
          </div>
          <div style={{ fontSize: 12, color: '#888', fontFamily: "'JetBrains Mono', monospace" }}>
            id {trade.tradeId} · open {trade.minutesElapsed} min ago · {trade.units.toLocaleString()} units
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 22, color: plColor, fontWeight: 800, lineHeight: 1.1 }}>
            ${trade.unrealizedPL.toFixed(2)}
          </div>
          <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>
            unrealized · {trade.unrealizedPips >= 0 ? '+' : ''}
            {trade.unrealizedPips.toFixed(1)} pips
          </div>
        </div>
      </div>

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
          sub={`${trade.distanceToTPPips.toFixed(1)}p to go (${(trade.tpProgress * 100).toFixed(0)}%)`}
        />
      </div>

      <div style={s.sizingGrid}>
        <SizingCell label="Alignment" value={`${trade.currentAlignmentScore}/100`} />
        <SizingCell label="Confidence" value={`${trade.currentConfidence}%`} />
        <SizingCell label="TP prob" value={`${(trade.tpProbability * 100).toFixed(0)}%`} />
        <SizingCell label="SL prob" value={`${(trade.slProbability * 100).toFixed(0)}%`} />
        <SizingCell label="Hold left" value={`${trade.updatedHoldWindow.minMinutes}–${trade.updatedHoldWindow.maxMinutes}m`} />
      </div>

      <div
        style={{
          background: stateStyle.bg,
          border: `1px solid ${stateStyle.bd}`,
          borderRadius: 8,
          padding: '10px 14px',
          marginBottom: 12,
          fontSize: 13,
          lineHeight: 1.5,
        }}
      >
        <div style={{ marginBottom: 4 }}>
          <span style={{ color: '#888' }}>Reason:</span>{' '}
          <span style={{ color: stateStyle.fg, fontWeight: 600 }}>{trade.exitReason}</span>
        </div>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12, color: '#aaa' }}>
          <span>
            time-decay: <span style={{ color: decayColor, fontWeight: 700 }}>{trade.timeDecayRisk}</span>
          </span>
          {trade.macroOpposes && <span style={{ color: '#ff6666', fontWeight: 700 }}>⚠ macro opposes</span>}
          {trade.alignmentDropped && <span style={{ color: '#ff8c00', fontWeight: 700 }}>⚠ alignment dropped</span>}
          {trade.conflictingTfCount > 0 && (
            <span>
              conflicts: <span style={{ color: '#ff8c00', fontWeight: 700 }}>{trade.conflictingTfCount}</span>
            </span>
          )}
        </div>
      </div>

      {/* Execution button driven by the exit recommendation. Hold/SL-move
          recommendations show no execution button — display only. */}
      {(() => {
        const closeMode = deriveCloseMode({
          classicExitRecommendation: trade.exitRecommendation,
          defaultPartialPercent: 50,
        });
        if (!closeMode) return null;
        return (
          <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <CloseTradeButton
              tradeId={trade.tradeId}
              instrument={trade.instrument}
              totalUnits={trade.units}
              unrealizedPL={trade.unrealizedPL}
              direction={trade.side}
              mode={closeMode.mode}
              partialPercent={closeMode.partialPercent}
              reason={trade.exitReason}
              isLive={isLive}
              onAfter={onAfterClose}
            />
          </div>
        );
      })()}

      <details>
        <summary style={{ cursor: 'pointer', color: '#888', fontSize: 13, fontWeight: 600 }}>Mini waterfall (current state)</summary>
        <div style={{ marginTop: 8 }}>
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

// ─── 30-min reassessment card ─────────────────────────────────────────────────

/**
 * Visual-only management action button. Always disabled until the future
 * auto-execution flag is wired through. Keeps the UI infrastructure in place
 * so the wiring later only needs to flip `disabled` → `false` and attach the
 * handler.
 */
function DisabledActionButton({ label, enabled }: { label: string; enabled: boolean }) {
  return (
    <button
      type="button"
      disabled
      title="Automation not enabled — recommendation only"
      style={{
        padding: '6px 12px',
        background: enabled ? 'var(--bg)' : 'transparent',
        border: `1px solid ${enabled ? 'var(--border)' : '#1a1a2e'}`,
        color: enabled ? 'var(--text)' : 'var(--muted)',
        borderRadius: 6,
        fontSize: 12,
        fontWeight: 600,
        fontFamily: 'inherit',
        cursor: 'not-allowed',
        opacity: enabled ? 0.85 : 0.5,
      }}
    >
      {label}
    </button>
  );
}

function ReassessRow({
  trade,
  onAfterClose,
  isLive,
}: {
  trade: ReassessTrade;
  onAfterClose: () => Promise<void> | void;
  isLive: boolean;
}) {
  if (trade.error) {
    return (
      <div style={{ ...s.rejectedRow, borderColor: '#5c1a1a' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 800, fontSize: 17 }}>
            {displayPair(trade.instrument)}
          </span>
          <Badge value="ERROR" type="bad" />
        </div>
        <div style={{ marginTop: 8, color: '#ff8c00', fontSize: 13 }}>{trade.error}</div>
      </div>
    );
  }

  const action = trade.recommendedAction ?? 'HOLD';
  const isExit = action.startsWith('EXIT') || action === 'PARTIAL_EXIT';
  const isProtect = action === 'PROTECT_PROFIT' || action.startsWith('MOVE_SL') || action === 'TRAIL_SL';
  const actionType: BadgeType = isExit ? 'bad' : action === 'HOLD' ? 'good' : isProtect ? 'info' : 'warn';
  const pl = trade.currentPnL ?? 0;
  const plColor = pl >= 0 ? '#2dff7a' : '#ff4d4d';

  return (
    <div style={{ ...s.card, padding: '16px 18px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 800, fontSize: 18 }}>
            {displayPair(trade.instrument)}
          </span>
          {trade.direction && (
            <Badge value={trade.direction.toUpperCase()} type={trade.direction === 'long' ? 'good' : 'bad'} />
          )}
          <Badge value={action} type={actionType} />
          {trade.classicTradeState && <Badge value={trade.classicTradeState} type="neutral" />}
          {trade.lifecycleRecommendation && (
            <Badge
              value={`→ ${trade.lifecycleRecommendation.action.toUpperCase().replace(/_/g, ' ')}`}
              type={
                trade.lifecycleRecommendation.action === 'hold'
                  ? 'good'
                  : trade.lifecycleRecommendation.action === 'close'
                    ? 'bad'
                    : trade.lifecycleRecommendation.urgency === 'high'
                      ? 'bad'
                      : trade.lifecycleRecommendation.urgency === 'medium'
                        ? 'warn'
                        : 'info'
              }
            />
          )}
          {trade.momentumStatus && (
            <Badge
              value={`momentum ${trade.momentumStatus}`}
              type={
                trade.momentumStatus === 'improving'
                  ? 'good'
                  : trade.momentumStatus === 'decaying'
                    ? 'bad'
                    : 'warn'
              }
            />
          )}
          {trade.holdStatus && (
            <Badge
              value={`hold ${trade.holdStatus.replace(/_/g, ' ')}`}
              type={
                trade.holdStatus === 'on_track'
                  ? 'good'
                  : trade.holdStatus === 'slow'
                    ? 'warn'
                    : 'bad'
              }
            />
          )}
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 18, color: plColor, fontWeight: 800 }}>
            ${pl.toFixed(2)}
          </div>
          {trade.profitRMultiple !== undefined && (
            <div style={{ fontSize: 12, color: '#888' }}>{trade.profitRMultiple.toFixed(2)}R</div>
          )}
        </div>
      </div>

      <div style={{ ...s.sizingGrid, marginTop: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))' }}>
        {trade.currentAlignmentScore !== undefined && (
          <SizingCell label="Alignment" value={`${trade.currentAlignmentScore}/100`} />
        )}
        {trade.currentConfidence !== undefined && (
          <SizingCell label="Confidence" value={`${trade.currentConfidence}%`} />
        )}
        {trade.candleStrengthScore !== undefined && (
          <SizingCell label="Candle Str" value={`${trade.candleStrengthScore}/100`} />
        )}
        {trade.marketState && <SizingCell label="Market" value={trade.marketState} />}
        {trade.multiTimeframeAlignmentScore !== undefined && (
          <SizingCell label="MTF Align" value={`${trade.multiTimeframeAlignmentScore}/100`} />
        )}
        {trade.distanceToTP !== undefined && (
          <SizingCell label="To TP" value={`${trade.distanceToTP.toFixed(1)}p`} />
        )}
        {trade.distanceToSL !== undefined && (
          <SizingCell label="To SL" value={`${trade.distanceToSL.toFixed(1)}p`} />
        )}
        {trade.minutesElapsed !== undefined && (
          <SizingCell label="Elapsed" value={`${trade.minutesElapsed}m`} />
        )}
        {trade.velocityScore !== undefined && (
          <SizingCell label="Velocity" value={`${trade.velocityScore}/100`} />
        )}
        {trade.momentumDecayScore !== undefined && (
          <SizingCell label="Decay" value={`${trade.momentumDecayScore}/100`} />
        )}
        {trade.opportunityCostScore !== undefined && (
          <SizingCell label="Opp. cost" value={`${trade.opportunityCostScore}/100`} />
        )}
        {trade.expectedRemainingHoldTime !== undefined && (
          <SizingCell label="Remaining" value={`${trade.expectedRemainingHoldTime}m`} />
        )}
      </div>

      {trade.dynamicTP && (
        <div style={{ ...s.factorsBox, marginTop: 10 }}>
          <span style={{ color: '#888' }}>Dynamic TP:</span>{' '}
          <span style={{ color: '#4db8ff', fontWeight: 700 }}>
            {trade.dynamicTP.currentRecommendedTargetPips}p
          </span>{' '}
          <span style={{ color: '#666' }}>
            (min {trade.dynamicTP.minTargetPips}p · base {trade.dynamicTP.baseTargetPips}p · max{' '}
            {trade.dynamicTP.maxTargetPips}p)
          </span>
        </div>
      )}

      {trade.lifecycleRecommendation && (
        <div style={{ ...s.factorsBox, marginTop: 6 }}>
          <div>
            <span style={{ color: '#888' }}>Lifecycle action:</span>{' '}
            <span
              style={{
                color:
                  trade.lifecycleRecommendation.urgency === 'high'
                    ? '#ff6666'
                    : trade.lifecycleRecommendation.urgency === 'medium'
                      ? '#ffaa00'
                      : '#2dff7a',
                fontWeight: 700,
              }}
            >
              {trade.lifecycleRecommendation.action.toUpperCase().replace(/_/g, ' ')}
            </span>{' '}
            <span style={{ color: '#666' }}>
              ({trade.lifecycleRecommendation.urgency} urgency · confidence{' '}
              {trade.lifecycleRecommendation.confidence}%)
            </span>
          </div>
          <div style={{ marginTop: 4, color: '#aaa', lineHeight: 1.5 }}>
            {trade.lifecycleRecommendation.reason}
          </div>
        </div>
      )}

      {trade.lifecycleRecommendation?.shouldAutoClose && (
        <div
          style={{
            marginTop: 8,
            padding: '8px 14px',
            background: '#320d0d',
            border: '1px solid #ff4d4d',
            color: '#ff8888',
            borderRadius: 8,
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          <strong>⚠ Auto-close armed:</strong>{' '}
          {trade.lifecycleRecommendation.autoCloseReason ?? 'high-urgency exit'}
        </div>
      )}

      {/* Signal Stack V3 — exit framework badges */}
      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        {trade.multiTargets?.currentStage && (
          <Badge
            value={`Stage ${trade.multiTargets.currentStage}`}
            type={
              trade.multiTargets.currentStage === 'TP3+'
                ? 'good'
                : trade.multiTargets.currentStage === 'TP2'
                  ? 'info'
                  : trade.multiTargets.currentStage === 'TP1'
                    ? 'warn'
                    : 'neutral'
            }
          />
        )}
        {trade.trendExhaustion && (
          <Badge
            value={`Trend ${trade.trendExhaustion.trendExhaustionStatus} ${trade.trendExhaustion.trendExhaustionScore}/100`}
            type={
              trade.trendExhaustion.trendExhaustionStatus === 'normal'
                ? 'good'
                : trade.trendExhaustion.trendExhaustionStatus === 'extended'
                  ? 'warn'
                  : 'bad'
            }
          />
        )}
        {trade.capitalEfficiency && (
          <Badge
            value={`Capital ${trade.capitalEfficiency.capitalEfficiencyLabel}`}
            type={
              trade.capitalEfficiency.capitalEfficiencyLabel === 'Excellent' ||
              trade.capitalEfficiency.capitalEfficiencyLabel === 'Good'
                ? 'good'
                : trade.capitalEfficiency.capitalEfficiencyLabel === 'Average'
                  ? 'info'
                  : trade.capitalEfficiency.capitalEfficiencyLabel === 'Poor'
                    ? 'warn'
                    : 'bad'
            }
          />
        )}
        {trade.breakeven?.eligible && <Badge value="Break-Even Eligible" type="good" />}
      </div>

      {/* Multi-target stage table */}
      {trade.multiTargets?.stages && (
        <div style={{ ...s.factorsBox, marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {trade.multiTargets.stages.map((st) => {
            const isCurrent = trade.multiTargets!.currentStage === st.stage ||
              (trade.multiTargets!.currentStage === 'TP3+' && st.stage === 'TP3');
            return (
              <div key={st.stage} style={{ display: 'flex', gap: 10 }}>
                <span style={{ minWidth: 36, color: isCurrent ? '#2dff7a' : '#888', fontWeight: 700 }}>
                  {st.stage}
                </span>
                <span style={{ color: '#aaa' }}>{st.pips}p</span>
                <span style={{ color: '#666' }}>@ {st.price}</span>
                <span style={{ color: '#666' }}>({st.multiple}R)</span>
              </div>
            );
          })}
        </div>
      )}

      {/* Break-even recommendation */}
      {trade.breakeven?.eligible && trade.breakeven.recommendedSL != null && (
        <div style={{ ...s.factorsBox, marginTop: 6 }}>
          <span style={{ color: '#888' }}>Break-Even Eligible — Recommended SL:</span>{' '}
          <span style={{ color: '#2dff7a', fontWeight: 700 }}>{trade.breakeven.recommendedSL}</span>
        </div>
      )}

      {/* Dynamic trail recommendation */}
      {trade.dynamicTrail?.recommended && trade.dynamicTrail.distancePips != null && (
        <div style={{ ...s.factorsBox, marginTop: 6 }}>
          <span style={{ color: '#888' }}>Dynamic trail (ATR × {trade.dynamicTrail.multiplier}):</span>{' '}
          <span style={{ color: '#4db8ff', fontWeight: 700 }}>{trade.dynamicTrail.distancePips}p</span>{' '}
          <span style={{ color: '#666' }}>@ {trade.dynamicTrail.price}</span>
        </div>
      )}

      {/* Partial-close plan */}
      {trade.partialClose && trade.partialClose.recommendedPartialClosePercent > 0 && (
        <div style={{ ...s.factorsBox, marginTop: 6 }}>
          <span style={{ color: '#888' }}>Partial close recommendation:</span>{' '}
          <span style={{ color: '#ffcc00', fontWeight: 700 }}>
            {trade.partialClose.recommendedPartialClosePercent}%
          </span>{' '}
          <span style={{ color: '#666' }}>— {trade.partialClose.reason}</span>
        </div>
      )}

      {/* Unified recommendation summary + conflict notes */}
      {trade.lifecycleRecommendation?.unifiedSummary && (
        <div
          style={{
            marginTop: 10,
            padding: '10px 12px',
            background: '#08080f',
            border: '1px solid #181830',
            borderRadius: 8,
            fontSize: 13,
            color: '#aaa',
            lineHeight: 1.5,
          }}
        >
          <strong style={{ color: '#e0e0ff' }}>Unified:</strong> {trade.lifecycleRecommendation.unifiedSummary}
        </div>
      )}

      {/* Execution panel — close/partial buttons activate when the
          recommendation calls for them. SL-move / TP-adjust / trailing-stop
          remain infrastructure-only buttons until those endpoints land. */}
      {(() => {
        const closeMode = deriveCloseMode({
          lifecycleAction: trade.lifecycleRecommendation?.action,
          classicAction: trade.recommendedAction,
          shouldAutoClose: trade.lifecycleRecommendation?.shouldAutoClose,
          partialPercent:
            trade.partialClose?.recommendedPartialClosePercent ??
            trade.partialExitPercent ??
            null,
          defaultPartialPercent: 25,
        });
        const reason =
          trade.lifecycleRecommendation?.unifiedSummary ??
          trade.lifecycleRecommendation?.reason ??
          (trade.managementReasons ?? []).join(' · ') ??
          '';
        const direction = trade.direction;
        const totalUnits = trade.units != null
          ? Math.abs(Number(trade.units))
          : 0;
        return (
          <div style={{ display: 'flex', gap: 6, marginTop: 12, flexWrap: 'wrap', alignItems: 'center' }}>
            <DisabledActionButton label="Apply Break-Even" enabled={!!trade.breakeven?.eligible} />
            <DisabledActionButton label="Apply TP Adjustment" enabled={!!trade.dynamicTP} />
            <DisabledActionButton label="Apply Trailing Stop" enabled={!!trade.dynamicTrail?.recommended} />
            {closeMode ? (
              <CloseTradeButton
                tradeId={trade.tradeId}
                instrument={trade.instrument}
                totalUnits={totalUnits || 1}
                unrealizedPL={trade.currentPnL}
                direction={direction}
                mode={closeMode.mode}
                partialPercent={closeMode.partialPercent}
                reason={reason}
                isLive={isLive}
                onAfter={onAfterClose}
              />
            ) : (
              <DisabledActionButton label="Close Trade" enabled={false} />
            )}
          </div>
        );
      })()}

      {trade.recommendedStopLoss != null && (
        <div style={{ ...s.factorsBox, marginTop: 10 }}>
          <span style={{ color: '#888' }}>Recommended SL:</span>{' '}
          <span style={{ color: '#ff8c00', fontWeight: 700 }}>{trade.recommendedStopLoss}</span>
        </div>
      )}
      {trade.recommendedTakeProfit != null && (
        <div style={{ ...s.factorsBox, marginTop: trade.recommendedStopLoss != null ? 6 : 10 }}>
          <span style={{ color: '#888' }}>Recommended TP:</span>{' '}
          <span style={{ color: '#2dff7a', fontWeight: 700 }}>{trade.recommendedTakeProfit}</span>
        </div>
      )}
      {trade.partialExitPercent != null && (
        <div style={{ ...s.factorsBox, marginTop: 6 }}>
          <span style={{ color: '#888' }}>Partial exit:</span>{' '}
          <span style={{ color: '#4db8ff', fontWeight: 700 }}>{trade.partialExitPercent}%</span>
        </div>
      )}

      {trade.managementReasons && trade.managementReasons.length > 0 && (
        <div style={{ marginTop: 10, fontSize: 13, color: '#aaa', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {trade.managementReasons.map((r, i) => (
            <div key={i} style={{ display: 'flex', gap: 8 }}>
              <span style={{ color: '#666' }}>·</span>
              <span>{r}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Section helpers ──────────────────────────────────────────────────────────

function SectionHeader({
  title,
  subtitle,
  right,
}: {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
}) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
      <div>
        <h3 style={{ margin: 0, fontSize: 16 }}>{title}</h3>
        {subtitle && (
          <p style={{ color: 'var(--muted)', marginTop: 4, fontSize: 12, lineHeight: 1.5 }}>{subtitle}</p>
        )}
      </div>
      {right}
    </div>
  );
}

function EmptyBlock({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: 20,
        background: 'var(--bg)',
        border: '1px dashed var(--border)',
        borderRadius: 8,
        textAlign: 'center',
        fontSize: 13,
        color: 'var(--muted)',
        lineHeight: 1.5,
      }}
    >
      {children}
    </div>
  );
}

// ─── Main exported component ──────────────────────────────────────────────────

export function ScannerStatusCard({ hasBroker }: { hasBroker: boolean }) {
  const [state, setState] = useState<NormalizedScan | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [activeTrades, setActiveTrades] = useState<ActiveTradesResponse | null>(null);
  const [activeLoading, setActiveLoading] = useState(false);
  const [activeError, setActiveError] = useState<string | null>(null);

  const [reassess, setReassess] = useState<ReassessResponse | null>(null);
  const [reassessLoading, setReassessLoading] = useState(false);
  const [reassessError, setReassessError] = useState<string | null>(null);

  const [calibration, setCalibration] = useState<CalibrationSnapshot | null>(null);
  const [calibrationLoading, setCalibrationLoading] = useState(false);
  const [calibrationError, setCalibrationError] = useState<string | null>(null);

  const [tradeLogs, setTradeLogs] = useState<TradeLogRow[]>([]);
  const [tradeLogsLoading, setTradeLogsLoading] = useState(false);
  const [tradeLogsError, setTradeLogsError] = useState<string | null>(null);
  const [tradeLogsFilter, setTradeLogsFilter] = useState<string>('all');

  const runScan = useCallback(async () => {
    setPending(true);
    setError(null);
    setState(null);
    try {
      const res = await fetch('/api/scanner/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const raw = await res.json();

      if (!res.ok || !raw?.ok) {
        // Surface the resolver's reason (e.g. no_credentials,
        // live_not_acknowledged) without storing partial scan data.
        setError(raw?.error || `HTTP ${res.status}`);
        setState({
          ok: false,
          scan: { qualified: [], rejected: [], meta: {} as ForexScanResult['meta'] },
          activeBroker: raw?.activeBroker ?? 'oanda',
          activeEnvironment: raw?.activeEnvironment ?? 'practice',
          isLiveTrading: false,
          error: raw?.error,
          brokerCredentialStatus: raw?.brokerCredentialStatus,
        });
        return;
      }

      // The Next.js route returns:
      //   { ok, activeBroker, activeEnvironment, isLiveTrading, isPaperTrading,
      //     scan: { qualified, rejected, meta } }
      const scan = (raw.scan ?? {}) as Partial<ForexScanResult>;
      setState({
        ok: true,
        scan: {
          qualified: scan.qualified ?? [],
          rejected: scan.rejected ?? [],
          meta: scan.meta ?? ({} as ForexScanResult['meta']),
        },
        activeBroker: raw.activeBroker ?? 'oanda',
        activeEnvironment: raw.activeEnvironment ?? 'practice',
        isLiveTrading: !!raw.isLiveTrading,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }, []);

  const refreshActiveTrades = useCallback(async () => {
    setActiveLoading(true);
    setActiveError(null);
    try {
      const res = await fetch('/api/scanner/active-trades/analysis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const json = await res.json();
      if (!res.ok || !json?.ok) throw new Error(json?.error || `HTTP ${res.status}`);
      setActiveTrades(json.analysis as ActiveTradesResponse);
    } catch (err) {
      setActiveError(err instanceof Error ? err.message : String(err));
    } finally {
      setActiveLoading(false);
    }
  }, []);

  const refreshReassess = useCallback(async () => {
    setReassessLoading(true);
    setReassessError(null);
    try {
      const res = await fetch('/api/scanner/active-trades/reassess', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const json = await res.json();
      if (!res.ok || !json?.ok) throw new Error(json?.error || `HTTP ${res.status}`);
      setReassess(json.reassessment as ReassessResponse);
    } catch (err) {
      setReassessError(err instanceof Error ? err.message : String(err));
    } finally {
      setReassessLoading(false);
    }
  }, []);

  const refreshTradeLogs = useCallback(async (eventTypeFilter?: string) => {
    setTradeLogsLoading(true);
    setTradeLogsError(null);
    try {
      const qs = new URLSearchParams({ limit: '50' });
      if (eventTypeFilter && eventTypeFilter !== 'all') qs.set('event_type', eventTypeFilter);
      const res = await fetch(`/api/scanner/trade-logs?${qs.toString()}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });
      const json = await res.json();
      if (!res.ok || !json?.ok) throw new Error(json?.error || `HTTP ${res.status}`);
      setTradeLogs((json.rows as TradeLogRow[]) ?? []);
    } catch (err) {
      setTradeLogsError(err instanceof Error ? err.message : String(err));
    } finally {
      setTradeLogsLoading(false);
    }
  }, []);

  const refreshCalibration = useCallback(async () => {
    setCalibrationLoading(true);
    setCalibrationError(null);
    try {
      const res = await fetch('/api/scanner/calibration', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const json = await res.json();
      if (!res.ok || !json?.ok) throw new Error(json?.error || `HTTP ${res.status}`);
      setCalibration(json.calibration as CalibrationSnapshot);
    } catch (err) {
      setCalibrationError(err instanceof Error ? err.message : String(err));
    } finally {
      setCalibrationLoading(false);
    }
  }, []);

  useEffect(() => {
    if (hasBroker) {
      refreshActiveTrades();
      refreshReassess();
    }
    // Calibration + trade logs are broker-free — fetch on mount regardless.
    refreshCalibration();
    refreshTradeLogs(tradeLogsFilter);
  }, [hasBroker, refreshActiveTrades, refreshReassess, refreshCalibration, refreshTradeLogs, tradeLogsFilter]);

  // Re-fetch both the analysis + reassess panels after any close-trade
  // execution so the UI reflects the new broker state.
  const refreshAfterClose = useCallback(async () => {
    await Promise.allSettled([
      refreshActiveTrades(),
      refreshReassess(),
      refreshTradeLogs(tradeLogsFilter),
    ]);
  }, [refreshActiveTrades, refreshReassess, refreshTradeLogs, tradeLogsFilter]);

  const scan = state?.scan;
  const qualified = scan?.qualified ?? [];
  // Trade execution is only offered when the scanner response confirms live
  // mode AND the call succeeded (state.ok). Anything less surfaces an inline
  // blocker on each signal card so the user knows what to fix.
  const isPaperEnv = state?.activeEnvironment === 'practice' || state?.activeEnvironment === 'paper';
  const liveExecutionEnabled = !!(state?.ok && state?.isLiveTrading);
  // Paper/practice can execute too — a successful scan means creds resolved for
  // that environment (the proxy 409s otherwise). Live still requires the live
  // gates (platform flag + live-ack), enforced upstream by the broker resolver.
  const paperExecutionEnabled = !!(state?.ok && !state?.isLiveTrading && isPaperEnv);
  const executionEnabled = liveExecutionEnabled || paperExecutionEnabled;
  const executionBlockerReason: string | null = !state?.ok
    ? 'Run a scan first to verify your broker resolution.'
    : !executionEnabled
      ? `Active environment is "${state.activeEnvironment ?? 'practice'}" — connect a broker for this mode (or switch to OANDA Live) to execute trades.`
      : null;
  const rejected = scan?.rejected ?? [];
  const meta = scan?.meta;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* ── Header card ───────────────────────────────────────────────── */}
      <section style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 10, padding: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 18 }}>Signal scanner</h2>
            <p style={{ color: 'var(--muted)', marginTop: 6, fontSize: 13, maxWidth: 640 }}>
              Multi-timeframe waterfall + entry-quality + asset-class qualification for forex, metals and indices.
              Live scan results below — qualified signals, rejection rationale, open trades, and 30-minute trade
              reassessments.
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
          <div style={{ marginTop: 16 }}>
            <EmptyBlock>
              Connect a broker account in <a href="/dashboard/settings">Settings</a> to enable the scanner.
            </EmptyBlock>
          </div>
        )}

        {hasBroker && !state && !error && !pending && (
          <div style={{ marginTop: 16 }}>
            <EmptyBlock>
              Press <strong>Run scan</strong> to fetch fresh signals with your active broker connection.
            </EmptyBlock>
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
            {state?.brokerCredentialStatus && (
              <div style={{ marginTop: 4, color: 'var(--muted)', fontSize: 12 }}>
                Resolver status: {state.brokerCredentialStatus}
              </div>
            )}
          </div>
        )}

        {/* Scan summary chips */}
        {state?.ok && meta && (
          <div
            style={{
              marginTop: 16,
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
              gap: 10,
            }}
          >
            <StatChip label="Qualified" value={String(qualified.length)} tone="good" />
            <StatChip label="Rejected" value={String(rejected.length)} />
            {meta.v3EngineMode !== undefined && (
              <StatChip
                label="V3 engine"
                value={String(meta.v3EngineMode)}
                tone={meta.v3EngineMode === 'off' ? 'bad' : 'good'}
              />
            )}
            {meta.v3Comparison?.counts?.evaluated !== undefined && (
              <StatChip label="V3 evaluated" value={String(meta.v3Comparison.counts.evaluated)} />
            )}
            <StatChip
              label="Mode"
              value={(state.activeEnvironment ?? '—').toString()}
              tone={state.isLiveTrading ? 'bad' : undefined}
            />
            <StatChip label="Broker" value={(state.activeBroker ?? '—').toUpperCase()} />
            {meta.session && <StatChip label="Session" value={meta.session} />}
            {meta.pairsScanned !== undefined && (
              <StatChip label="Pairs scanned" value={String(meta.pairsScanned)} />
            )}
            {meta.minAlignmentScore !== undefined && (
              <StatChip label="Min align" value={`${meta.minAlignmentScore}/100`} />
            )}
            {meta.minConfidence !== undefined && (
              <StatChip label="Min conf" value={`${meta.minConfidence}%`} />
            )}
            {meta.accountBalanceUSD != null && (
              <StatChip label="Account" value={`$${meta.accountBalanceUSD.toFixed(2)}`} />
            )}
          </div>
        )}

        {meta?.aggressiveRiskWarning && (
          <div
            style={{
              marginTop: 16,
              padding: '10px 14px',
              background: 'linear-gradient(135deg, #2d1100, #401400)',
              border: '1px solid #ff8c00',
              borderRadius: 8,
              color: '#ffcc66',
              fontSize: 13,
              lineHeight: 1.5,
            }}
          >
            <strong style={{ marginRight: 8 }}>
              {meta.riskMode === 'dynamic' ? '⚙ DYNAMIC RISK MODE' : '⚠ FIXED-DOLLAR RISK MODE'}
            </strong>
            {meta.aggressiveRiskWarning}
          </div>
        )}
      </section>

      {/* ── Recent signals (qualified) ──────────────────────────────────── */}
      <section style={s.section}>
        <SectionHeader
          title={`Recent signals (${qualified.length})`}
          subtitle="Qualified setups from the most recent scan with full waterfall + entry-quality detail."
        />
        {!state ? (
          <EmptyBlock>Run a scan to populate qualified signals.</EmptyBlock>
        ) : qualified.length === 0 ? (
          <EmptyBlock>
            No signals met the qualification threshold
            {meta?.minAlignmentScore && meta?.minConfidence
              ? ` (need alignment ≥ ${meta.minAlignmentScore}/100 and confidence ≥ ${meta.minConfidence}%).`
              : '.'}
          </EmptyBlock>
        ) : (
          qualified.map((sig) => (
            <SignalCard
              key={`${sig.pair}_${sig.direction}`}
              signal={sig}
              executionEnabled={executionEnabled}
              executionBlockerReason={executionBlockerReason}
              isPaper={paperExecutionEnabled}
            />
          ))
        )}
      </section>

      {/* ── Rejected signals / scan details ──────────────────────────────── */}
      <section style={s.section}>
        <SectionHeader
          title={`Rejected signals (${rejected.length})`}
          subtitle="Pairs that failed the waterfall — full rejection reasons and which layer they failed at."
        />
        {!state ? (
          <EmptyBlock>Run a scan to populate rejection details.</EmptyBlock>
        ) : rejected.length === 0 ? (
          <EmptyBlock>No rejections — all scanned pairs qualified.</EmptyBlock>
        ) : (
          rejected.map((sig, i) => <RejectedRow key={`${sig.pair}_${i}`} sig={sig} />)
        )}
      </section>

      {/* ── Open trades (live reassessment) ─────────────────────────────── */}
      <section style={s.section}>
        <SectionHeader
          title={`Open trades (${activeTrades?.trades?.length ?? 0})`}
          subtitle="Live per-trade reassessment — current alignment, confidence, exit recommendation, and mini-waterfall."
          right={
            <button
              type="button"
              onClick={refreshActiveTrades}
              disabled={activeLoading || !hasBroker}
              style={s.refreshBtn}
            >
              {activeLoading ? 'Refreshing…' : 'Refresh'}
            </button>
          }
        />
        {activeError && (
          <div
            style={{
              padding: '10px 14px',
              background: '#320d0d',
              border: '1px solid #5c1a1a',
              color: 'var(--bad)',
              borderRadius: 6,
              fontSize: 13,
            }}
          >
            <strong>Failed:</strong> {activeError}
          </div>
        )}
        {!activeError && (!activeTrades?.trades || activeTrades.trades.length === 0) && !activeLoading && (
          <EmptyBlock>
            {activeTrades?.meta?.notice || 'No open trades on the broker account.'}
          </EmptyBlock>
        )}
        {activeTrades?.trades?.map((t) => (
          <ActiveTradeCard
            key={t.tradeId}
            trade={t}
            onAfterClose={refreshAfterClose}
            isLive={!!state?.isLiveTrading}
          />
        ))}
      </section>

      {/* ── 30-min reassessment ─────────────────────────────────────────── */}
      <section style={s.section}>
        <SectionHeader
          title={`30-min reassessment (${reassess?.trades?.length ?? 0})`}
          subtitle="Per-trade management plan — trailing SL, partials, TP reduction, invalidation. Recommendations only."
          right={
            <button
              type="button"
              onClick={refreshReassess}
              disabled={reassessLoading || !hasBroker}
              style={s.refreshBtn}
            >
              {reassessLoading ? 'Reassessing…' : 'Reassess now'}
            </button>
          }
        />
        {reassessError && (
          <div
            style={{
              padding: '10px 14px',
              background: '#320d0d',
              border: '1px solid #5c1a1a',
              color: 'var(--bad)',
              borderRadius: 6,
              fontSize: 13,
            }}
          >
            <strong>Failed:</strong> {reassessError}
          </div>
        )}
        {reassess?.meta && (
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            {reassess.meta.reassessedAt && (
              <span>Last: {new Date(reassess.meta.reassessedAt).toLocaleTimeString()}</span>
            )}
            {reassess.meta.session && <span>Session: {reassess.meta.session}</span>}
            {reassess.meta.environment && <span>Env: {reassess.meta.environment}</span>}
            {reassess.meta.autoCloseEnabled === false && (
              <span style={{ color: '#ffcc00', fontWeight: 700 }}>auto-close OFF (recommendations only)</span>
            )}
          </div>
        )}
        {!reassessError && (!reassess?.trades || reassess.trades.length === 0) && !reassessLoading && (
          <EmptyBlock>
            {reassess?.meta?.notice || 'No open positions to reassess.'}
          </EmptyBlock>
        )}
        {reassess?.trades?.map((t) => (
          <ReassessRow
            key={t.tradeId}
            trade={t}
            onAfterClose={refreshAfterClose}
            isLive={!!state?.isLiveTrading}
          />
        ))}
      </section>

      {/* ── Strategy calibration (self-improvement layer) ──────────────────── */}
      <section style={s.section}>
        <SectionHeader
          title="Strategy calibration"
          subtitle="Monthly Expected-RR vs Realized-R. The rejection threshold auto-tightens when projections consistently overshoot reality, so qualifying trades clear a higher bar."
          right={
            <button
              type="button"
              onClick={refreshCalibration}
              disabled={calibrationLoading}
              style={s.refreshBtn}
            >
              {calibrationLoading ? 'Refreshing…' : 'Refresh'}
            </button>
          }
        />
        {calibrationError && (
          <div
            style={{
              padding: '10px 14px',
              background: '#320d0d',
              border: '1px solid #5c1a1a',
              color: 'var(--bad)',
              borderRadius: 6,
              fontSize: 13,
            }}
          >
            <strong>Failed:</strong> {calibrationError}
          </div>
        )}
        {!calibrationError && !calibration && !calibrationLoading && (
          <EmptyBlock>Calibration data unavailable.</EmptyBlock>
        )}
        {calibration && <CalibrationPanel snapshot={calibration} />}
      </section>

      {/* ── Trade logs / history ──────────────────────────────────────────── */}
      <section style={s.section}>
        <SectionHeader
          title={`Trade logs (${tradeLogs.length})`}
          subtitle="Per-user history of opens, closes, reassessments, and recommendations — read from Supabase. Filter by event type to narrow down."
          right={
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <select
                value={tradeLogsFilter}
                onChange={(e) => setTradeLogsFilter(e.target.value)}
                style={{
                  padding: '6px 10px',
                  background: 'var(--bg)',
                  color: 'var(--text)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  fontFamily: 'inherit',
                  fontSize: 12,
                }}
              >
                <option value="all">All events</option>
                <option value="opened">Opened</option>
                <option value="closed">Closed</option>
                <option value="partial_closed">Partial closed</option>
                <option value="manual_close_executed">Manual close</option>
                <option value="auto_close_recommended">Auto-close recommended</option>
                <option value="reassessed">Reassessed</option>
                <option value="error">Errors</option>
              </select>
              <button
                type="button"
                onClick={() => refreshTradeLogs(tradeLogsFilter)}
                disabled={tradeLogsLoading}
                style={s.refreshBtn}
              >
                {tradeLogsLoading ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>
          }
        />
        {tradeLogsError && (
          <div
            style={{
              padding: '10px 14px',
              background: '#320d0d',
              border: '1px solid #5c1a1a',
              color: 'var(--bad)',
              borderRadius: 6,
              fontSize: 13,
            }}
          >
            <strong>Failed:</strong> {tradeLogsError}
          </div>
        )}
        {!tradeLogsError && tradeLogs.length === 0 && !tradeLogsLoading && (
          <EmptyBlock>
            No trade events yet. Open a trade or run a reassessment to see history here.
          </EmptyBlock>
        )}
        {tradeLogs.length > 0 && <TradeLogTable rows={tradeLogs} />}
      </section>
    </div>
  );
}

function TradeLogTable({ rows }: { rows: TradeLogRow[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {rows.map((r) => <TradeLogRowItem key={r.id} row={r} />)}
    </div>
  );
}

function TradeLogRowItem({ row }: { row: TradeLogRow }) {
  const tone: BadgeType =
    row.event_type === 'opened' ? 'good'
    : row.event_type === 'closed' || row.event_type === 'manual_close_executed' ? 'info'
    : row.event_type === 'partial_closed' ? 'warn'
    : row.event_type === 'auto_close_recommended' ? 'bad'
    : row.event_type === 'error' ? 'bad'
    : 'neutral';
  const pl = row.realized_pl ?? row.unrealized_pl ?? null;
  return (
    <details
      style={{
        background: 'var(--bg)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: '10px 14px',
      }}
    >
      <summary
        style={{
          cursor: 'pointer',
          display: 'flex',
          gap: 12,
          alignItems: 'center',
          flexWrap: 'wrap',
          listStyle: 'none',
        }}
      >
        <span style={{ fontSize: 12, color: 'var(--muted)', fontFamily: "'JetBrains Mono', ui-monospace, monospace", minWidth: 160 }}>
          {new Date(row.created_at).toLocaleString()}
        </span>
        <Badge value={row.event_type.replace(/_/g, ' ').toUpperCase()} type={tone} />
        {row.instrument && (
          <span style={{ fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontWeight: 700, color: 'var(--text)' }}>
            {displayPair(row.instrument)}
          </span>
        )}
        {row.side && (
          <Badge value={row.side.toUpperCase()} type={row.side === 'long' ? 'good' : 'bad'} />
        )}
        {row.units != null && (
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>{row.units.toLocaleString()} units</span>
        )}
        {row.units_closed != null && (
          <span style={{ fontSize: 12, color: '#ffcc00' }}>↓{row.units_closed.toLocaleString()} closed</span>
        )}
        {pl != null && (
          <span style={{ fontSize: 13, color: pl >= 0 ? '#2dff7a' : '#ff6666', fontFamily: "'JetBrains Mono', monospace", fontWeight: 700 }}>
            ${pl.toFixed(2)}
          </span>
        )}
        {row.recommendation && (
          <span style={{ fontSize: 12, color: '#4db8ff', fontFamily: "'JetBrains Mono', monospace" }}>
            rec: {row.recommendation}
          </span>
        )}
        {row.confidence != null && (
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>conf {row.confidence}</span>
        )}
      </summary>
      <div style={{ marginTop: 8, fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
        {row.reason && (
          <div style={{ marginBottom: 6 }}>
            <strong style={{ color: 'var(--text)' }}>Reason:</strong> {row.reason}
          </div>
        )}
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontFamily: "'JetBrains Mono', ui-monospace, monospace" }}>
          {row.trade_id && <span>tradeId={row.trade_id}</span>}
          {row.broker_order_id && row.broker_order_id !== row.trade_id && (
            <span>orderId={row.broker_order_id}</span>
          )}
          <span>{row.broker}/{row.environment}</span>
          {row.broker_account_id && <span>acct={row.broker_account_id}</span>}
          {row.entry_price != null && <span>entry={row.entry_price}</span>}
          {row.exit_price != null && <span>exit={row.exit_price}</span>}
          {row.tp != null && <span>TP={row.tp}</span>}
          {row.sl != null && <span>SL={row.sl}</span>}
        </div>
        {row.raw_payload != null && (
          <details style={{ marginTop: 6 }}>
            <summary style={{ cursor: 'pointer', color: 'var(--muted)' }}>Raw payload</summary>
            <pre
              style={{
                marginTop: 6,
                padding: 8,
                background: '#08080f',
                border: '1px solid #1a1a2e',
                borderRadius: 6,
                color: '#aaa',
                fontSize: 11,
                lineHeight: 1.4,
                maxHeight: 260,
                overflow: 'auto',
              }}
            >
              {JSON.stringify(row.raw_payload, null, 2)}
            </pre>
          </details>
        )}
      </div>
    </details>
  );
}

function CalibrationPanel({ snapshot }: { snapshot: CalibrationSnapshot }) {
  const tightened =
    snapshot.calibratedRejectionThreshold > snapshot.defaultRejectionThreshold + 0.001;
  const loosened =
    snapshot.calibratedRejectionThreshold < snapshot.defaultRejectionThreshold - 0.001;
  const cr = snapshot.rolling.captureRatio;
  const crColor =
    cr == null ? 'var(--muted)' : cr >= 0.9 ? 'var(--good)' : cr >= 0.7 ? 'var(--warn)' : 'var(--bad)';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
          gap: 10,
        }}
      >
        <StatChip
          label="Active threshold"
          value={String(snapshot.calibratedRejectionThreshold)}
          tone={tightened ? 'bad' : loosened ? 'good' : undefined}
        />
        <StatChip label="Default threshold" value={String(snapshot.defaultRejectionThreshold)} />
        <StatChip
          label="Capture ratio"
          value={cr == null ? '—' : String(cr)}
          tone={cr == null ? undefined : cr >= 0.9 ? 'good' : cr < 0.7 ? 'bad' : undefined}
        />
        <StatChip label="Sample size" value={String(snapshot.rolling.sampleCount)} />
        {snapshot.rolling.avgExpectedRR !== undefined && (
          <StatChip label="Avg Expected RR" value={String(snapshot.rolling.avgExpectedRR)} />
        )}
        {snapshot.rolling.avgRealizedR !== undefined && (
          <StatChip label="Avg Realized R" value={String(snapshot.rolling.avgRealizedR)} />
        )}
      </div>

      <div
        style={{
          padding: '10px 14px',
          background: 'var(--bg)',
          border: `1px solid ${tightened ? '#5c4400' : 'var(--border)'}`,
          borderRadius: 8,
          fontSize: 13,
          lineHeight: 1.5,
          color: tightened ? '#ffcc66' : 'var(--muted)',
        }}
      >
        <strong style={{ color: 'var(--text)' }}>
          {tightened ? '⚙ Tightened: ' : loosened ? '⚙ Loosened: ' : '⚙ Calibrated: '}
        </strong>
        {snapshot.adjustmentReason}
      </div>

      {snapshot.monthly.length === 0 ? (
        <EmptyBlock>No resolved trades yet — monthly stats appear once trades close.</EmptyBlock>
      ) : (
        <div
          style={{
            background: 'var(--bg)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: '10px 14px',
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            fontSize: 12,
            color: '#aaa',
            overflowX: 'auto',
          }}
        >
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '110px 80px 100px 100px 100px 80px',
              gap: 10,
              fontWeight: 700,
              color: 'var(--muted)',
              borderBottom: '1px solid var(--border)',
              paddingBottom: 6,
              marginBottom: 6,
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
            }}
          >
            <span>Month</span>
            <span>Samples</span>
            <span>Avg E[RR]</span>
            <span>Avg Real R</span>
            <span>Capture</span>
            <span>Win rate</span>
          </div>
          {snapshot.monthly.map((m) => (
            <div
              key={m.month}
              style={{
                display: 'grid',
                gridTemplateColumns: '110px 80px 100px 100px 100px 80px',
                gap: 10,
                padding: '6px 0',
                color: 'var(--text)',
              }}
            >
              <span style={{ color: 'var(--text)', fontWeight: 600 }}>{m.month}</span>
              <span>{m.sampleCount}</span>
              <span style={{ color: '#4db8ff' }}>{m.avgExpectedRR}</span>
              <span style={{ color: m.avgRealizedR >= 0 ? '#2dff7a' : '#ff6666' }}>
                {m.avgRealizedR}
              </span>
              <span
                style={{
                  color: m.captureRatio >= 0.9 ? '#2dff7a' : m.captureRatio >= 0.7 ? '#ffcc00' : '#ff6666',
                }}
              >
                {(m.captureRatio * 100).toFixed(0)}%
              </span>
              <span>{(m.winRate * 100).toFixed(0)}%</span>
            </div>
          ))}
        </div>
      )}
      <span style={{ fontSize: 11, color: 'var(--muted)' }}>
        Updated {new Date(snapshot.computedAt).toLocaleString()}. Sample window: rolling{' '}
        {snapshot.lookbackTrades} trades · minimum {snapshot.minSamplesForAdjust} required to
        adjust threshold. {!snapshot.eligibleForAdjustment && '— Using default threshold until threshold becomes eligible.'}
      </span>
      <span style={{ fontSize: 11, color: '#888', fontStyle: 'italic' }}>
        Trade-history data is currently platform-wide; per-user calibration follows once trade
        history moves into Supabase.
      </span>
    </div>
  );
}

function StatChip({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
  return (
    <div
      style={{
        padding: '12px 14px',
        background: 'var(--bg)',
        border: '1px solid var(--border)',
        borderRadius: 8,
      }}
    >
      <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '1px', fontWeight: 600 }}>
        {label}
      </div>
      <div
        style={{
          marginTop: 4,
          fontSize: 15,
          fontWeight: 700,
          color: tone === 'good' ? 'var(--good)' : tone === 'bad' ? 'var(--bad)' : 'var(--text)',
        }}
      >
        {value}
      </div>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  section: {
    background: 'var(--panel)',
    border: '1px solid var(--border)',
    borderRadius: 10,
    padding: 20,
  },
  card: {
    background: '#0d0d1a',
    border: '1px solid #1e1e30',
    borderRadius: 12,
    padding: '20px 22px',
    marginBottom: 14,
    color: '#e0e0ff',
  },
  priceGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    gap: 10,
    background: '#08080f',
    borderRadius: 8,
    padding: '14px 12px',
    marginBottom: 12,
  },
  sizingGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(100px, 1fr))',
    gap: 10,
    background: '#0a0a10',
    borderRadius: 8,
    padding: '12px 10px',
    marginBottom: 12,
    border: '1px solid #111120',
  },
  riskGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))',
    gap: 10,
    background: '#11070a',
    borderRadius: 8,
    padding: '12px 10px',
    marginBottom: 12,
    border: '1px solid #3a1620',
  },
  intradayGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))',
    gap: 8,
    background: '#07070e',
    border: '1px solid #151528',
    borderRadius: 8,
    padding: '12px 10px',
    marginBottom: 12,
  },
  indicatorRow: {
    display: 'flex',
    gap: 20,
    flexWrap: 'wrap',
    marginTop: 4,
  },
  breakdownGrid: {
    background: '#08080f',
    borderRadius: 8,
    padding: '10px 12px',
    marginTop: 8,
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },
  factorsBox: {
    background: '#07070e',
    border: '1px solid #151528',
    borderRadius: 6,
    padding: '8px 12px',
    marginBottom: 10,
    fontSize: 12,
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  },
  warnBox: {
    background: '#1a0a00',
    border: '1px solid #7a3200',
    color: '#ff8c00',
    borderRadius: 8,
    padding: '10px 14px',
    marginBottom: 10,
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    fontSize: 12,
    lineHeight: 1.55,
  },
  rejectedRow: {
    background: '#0a0a12',
    border: '1px solid #1a1218',
    borderRadius: 10,
    padding: '14px 18px',
    marginBottom: 10,
    color: '#e0e0ff',
  },
  refreshBtn: {
    padding: '8px 16px',
    background: 'var(--bg)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    fontFamily: 'inherit',
    fontWeight: 600,
    fontSize: 12,
    cursor: 'pointer',
  },
};
