'use client';

import { useCallback, useEffect, useState } from 'react';

type WatchTier = 'hot' | 'near';
type ConfirmationState = 'pass' | 'waiting' | 'blocked' | 'not_evaluated' | 'info';

type Stage1Metrics = {
  score?: number;
  minScore?: number;
  rr?: number;
  minRR?: number;
  spread?: number;
  maxSpread?: number;
  newsBlocked?: boolean;
  tpHitConfidence?: number;
  minTpHitConfidence?: number | null;
};

type Stage2Metrics = {
  minSupports?: number;
};

type ConfirmationStage = {
  allowed?: boolean;
  state?: string;
  reasons?: string[];
  checkedAt?: string;
  metrics?: Stage1Metrics & Stage2Metrics;
  primaryTriggers?: string[];
  supports?: string[];
};

type WatchSignal = {
  pair?: string;
  instrument?: string;
  direction?: 'long' | 'short' | 'neutral' | null;
  reason?: string;
  rejectionReasons?: string[];
  confidence?: number;
  tpHitConfidence?: number;
  minimumTpHitConfidence?: number;
  score?: number;
  v3Score?: number;
  expectedRR?: number;
  rr?: number;
  riskReward?: number;
  spreadPips?: number;
  displayQualification?: string;
  entryTiming?: { status?: string; reason?: string } | null;
  alignment?: { timeframeAlignmentScore?: number } | null;
  primaryTimeframeAlignment?: {
    passed?: boolean;
    score?: number;
    minimumScore?: number;
    reason?: string;
  } | null;
  qualityConfirmation?: {
    stage1?: ConfirmationStage | null;
    stage2?: ConfirmationStage | null;
    checkedAt?: string;
  } | null;
  newsRisk?: { blocked?: boolean; reason?: string } | null;
  v3?: {
    score?: number;
    fib?: {
      timeframeUsed?: string | null;
      swingHigh?: number | null;
      swingLow?: number | null;
      retracementLevels?: { level382?: number | null } | null;
    } | null;
  } | null;
  fibonacci?: {
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
    meta?: { scannedAt?: string };
  };
  error?: string;
};

type ConfirmationItem = {
  label: string;
  state: ConfirmationState;
  value: string;
  detail?: string;
};

type ProgressSummary = {
  state: ConfirmationState;
  label: string;
  detail: string;
};

function finite(...values: unknown[]): number | null {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function displayPair(signal: WatchSignal): string {
  const pair = String(signal.pair || signal.instrument || 'UNKNOWN');
  if (pair === 'XAU_USD') return 'Gold';
  if (pair === 'XAG_USD') return 'Silver';
  return pair.replace('_', '/');
}

function words(value: string): string {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

function readableList(values: string[] | undefined): string {
  if (!Array.isArray(values) || values.length === 0) return 'None confirmed';
  return values.map(words).join(', ');
}

function firstReason(values: string[] | undefined, fallback: string): string {
  return Array.isArray(values) && values.length > 0 ? String(values[0]) : fallback;
}

function formatWatchPrice(signal: WatchSignal, value: unknown): string {
  const parsed = finite(value);
  if (parsed == null) return '—';
  const pair = String(signal.pair || signal.instrument || '').toUpperCase();
  if (pair === 'XAU_USD' || pair === 'XAG_USD') return parsed.toFixed(2);
  if (pair.includes('JPY')) return parsed.toFixed(3);
  return parsed.toFixed(5);
}

function confirmationTime(signal: WatchSignal): string | null {
  return signal.qualityConfirmation?.checkedAt ||
    signal.qualityConfirmation?.stage2?.checkedAt ||
    signal.qualityConfirmation?.stage1?.checkedAt ||
    null;
}

function progressSummary(signal: WatchSignal): ProgressSummary {
  const stage1 = signal.qualityConfirmation?.stage1;
  const stage2 = signal.qualityConfirmation?.stage2;
  const timing = String(signal.entryTiming?.status || '').toLowerCase();
  const stage2State = String(stage2?.state || '').toLowerCase();

  if (!stage1 && !stage2) {
    return {
      state: 'not_evaluated',
      label: 'ANALYSIS INCOMPLETE',
      detail: 'The scan returned alignment context, but it did not return native V3 Stage 1 or Stage 2 results.',
    };
  }
  if (!stage1) {
    return { state: 'not_evaluated', label: 'STAGE 1 NOT RUN', detail: 'No native Stage 1 setup result was returned.' };
  }
  if (stage1.allowed !== true) {
    return { state: 'blocked', label: 'BLOCKED AT STAGE 1', detail: firstReason(stage1.reasons, 'One or more setup gates failed.') };
  }
  if (!stage2) {
    return { state: 'not_evaluated', label: 'STAGE 2 NOT RUN', detail: 'Stage 1 passed, but no native Stage 2 trigger result was returned.' };
  }
  if (stage2.allowed === true && timing === 'valid_entry') {
    return { state: 'pass', label: 'V3 CONFIRMATIONS COMPLETE', detail: 'Stage 1 and Stage 2 passed. Execution gates still apply.' };
  }
  if (stage2State === 'watch' || timing === 'too_early' || timing === 'wait_for_retest') {
    return { state: 'waiting', label: 'IN PROGRESS · STAGE 2', detail: firstReason(stage2.reasons, 'Waiting for a fresh trigger or retest.') };
  }
  return { state: 'blocked', label: 'BLOCKED AT STAGE 2', detail: firstReason(stage2.reasons, 'One or more trigger gates failed.') };
}

function watchReason(signal: WatchSignal, tier: WatchTier): string {
  const stage1 = signal.qualityConfirmation?.stage1;
  const stage2 = signal.qualityConfirmation?.stage2;

  if (!stage1 && !stage2) {
    return 'Only alignment-level dashboard context was calculated for this card. Native Stage 1 and Stage 2 were not returned, so no execution progress is being assumed.';
  }

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

function timingState(status: string): ConfirmationState {
  if (status === 'valid_entry') return 'pass';
  if (status === 'too_early' || status === 'wait_for_retest') return 'waiting';
  if (status === 'late_entry' || status === 'invalidated' || status === 'news_blocked') return 'blocked';
  return 'not_evaluated';
}

function buildConfirmations(signal: WatchSignal): ConfirmationItem[] {
  const stage1 = signal.qualityConfirmation?.stage1;
  const stage2 = signal.qualityConfirmation?.stage2;
  const stage1Metrics = stage1?.metrics;
  const stage2Metrics = stage2?.metrics;

  const alignment = finite(signal.primaryTimeframeAlignment?.score, signal.alignment?.timeframeAlignmentScore);
  const minimumAlignment = finite(signal.primaryTimeframeAlignment?.minimumScore) ?? 67;
  const alignmentPassed = signal.primaryTimeframeAlignment?.passed === true ||
    (alignment != null && alignment >= minimumAlignment);
  const v3Score = finite(signal.v3Score, signal.v3?.score, signal.score, stage1Metrics?.score);
  const minimumScore = finite(stage1Metrics?.minScore) ?? 62;
  const rr = finite(signal.expectedRR, signal.rr, signal.riskReward, stage1Metrics?.rr);
  const minimumRR = finite(stage1Metrics?.minRR) ?? 1.5;
  const spread = finite(signal.spreadPips, stage1Metrics?.spread);
  const maximumSpread = finite(stage1Metrics?.maxSpread) ?? 3.5;
  const confidence = finite(signal.tpHitConfidence, signal.confidence, stage1Metrics?.tpHitConfidence);
  const minimumConfidence = finite(signal.minimumTpHitConfidence, stage1Metrics?.minTpHitConfidence);
  const timing = String(signal.entryTiming?.status || '').toLowerCase();
  const newsBlocked = typeof stage1Metrics?.newsBlocked === 'boolean'
    ? stage1Metrics.newsBlocked
    : typeof signal.newsRisk?.blocked === 'boolean'
      ? signal.newsRisk.blocked
      : null;
  const primaryTriggers = stage2?.primaryTriggers || [];
  const supports = stage2?.supports || [];
  const minimumSupports = finite(stage2Metrics?.minSupports) ?? 1;
  const stage2State = String(stage2?.state || '').toLowerCase();
  const progress = progressSummary(signal);

  return [
    {
      label: 'Calculation source',
      state: stage1 || stage2 ? 'info' : 'not_evaluated',
      value: stage1 || stage2 ? 'Native V3 confirmation payload' : 'Legacy dashboard context only',
      detail: stage1 || stage2
        ? 'The card contains actual Stage 1/Stage 2 output.'
        : 'The bot did not return the native confirmation payload for this card.',
    },
    {
      label: 'Primary alignment',
      state: alignment == null ? 'not_evaluated' : alignmentPassed ? 'pass' : 'blocked',
      value: alignment == null ? 'Not calculated' : `${alignment}/100 · minimum ${minimumAlignment}`,
      detail: signal.primaryTimeframeAlignment?.reason,
    },
    {
      label: 'V3 setup score',
      state: v3Score == null ? 'not_evaluated' : v3Score >= minimumScore ? 'pass' : 'blocked',
      value: v3Score == null ? 'Not calculated' : `${v3Score} · minimum ${minimumScore}`,
      detail: v3Score != null && v3Score < minimumScore
        ? `Needs ${minimumScore - v3Score} more point${minimumScore - v3Score === 1 ? '' : 's'}.`
        : undefined,
    },
    {
      label: 'R:R geometry',
      state: rr == null ? 'not_evaluated' : rr >= minimumRR ? 'pass' : 'blocked',
      value: rr == null ? 'Entry, stop, and target were not returned' : `${rr.toFixed(2)}R · minimum ${minimumRR.toFixed(2)}R`,
      detail: rr == null ? 'The 1.5R rule is preset; this card is missing the pair-specific calculated geometry.' : undefined,
    },
    {
      label: 'Spread',
      state: spread == null ? 'not_evaluated' : spread <= maximumSpread ? 'pass' : 'blocked',
      value: spread == null ? 'Not returned' : `${spread.toFixed(1)} pips · maximum ${maximumSpread.toFixed(1)}`,
    },
    {
      label: 'News gate',
      state: newsBlocked == null ? 'not_evaluated' : newsBlocked ? 'blocked' : 'pass',
      value: newsBlocked == null ? 'Not returned' : newsBlocked ? 'Blocked by news risk' : 'Clear',
      detail: signal.newsRisk?.reason,
    },
    {
      label: 'Entry timing',
      state: timingState(timing),
      value: timing ? words(timing) : 'Not evaluated',
      detail: signal.entryTiming?.reason,
    },
    {
      label: 'Stage 1 setup',
      state: !stage1 ? 'not_evaluated' : stage1.allowed === true ? 'pass' : 'blocked',
      value: !stage1 ? 'Native Stage 1 result missing' : stage1.allowed === true ? 'Passed' : 'Blocked',
      detail: stage1
        ? firstReason(stage1.reasons, 'All Stage 1 setup gates passed.')
        : 'No Stage 1 result means this pair is not confirmed as a valid setup.',
    },
    {
      label: 'Primary trigger',
      state: !stage2
        ? 'not_evaluated'
        : primaryTriggers.length > 0
          ? 'pass'
          : stage2State === 'watch'
            ? 'waiting'
            : 'blocked',
      value: !stage2 ? 'Not evaluated' : readableList(primaryTriggers),
      detail: !stage2 || primaryTriggers.length > 0
        ? undefined
        : 'Waiting for a confirmed retest, liquidity sweep, aligned BOS/CHoCH, or compression-to-expansion trigger.',
    },
    {
      label: 'Supporting confirmation',
      state: !stage2
        ? 'not_evaluated'
        : supports.length >= minimumSupports
          ? 'pass'
          : stage2State === 'watch'
            ? 'waiting'
            : 'blocked',
      value: !stage2 ? 'Not evaluated' : `${supports.length}/${minimumSupports} · ${readableList(supports)}`,
    },
    {
      label: 'Stage 2 trigger',
      state: !stage2
        ? 'not_evaluated'
        : stage2.allowed === true
          ? 'pass'
          : stage2State === 'watch'
            ? 'waiting'
            : 'blocked',
      value: !stage2 ? 'Native Stage 2 result missing' : stage2.allowed === true ? 'Ready' : words(stage2State || 'blocked'),
      detail: stage2 ? firstReason(stage2.reasons, 'All Stage 2 trigger gates passed.') : 'No native trigger evaluation was returned.',
    },
    {
      label: 'TP-hit confidence',
      state: confidence == null
        ? 'not_evaluated'
        : minimumConfidence == null
          ? 'info'
          : confidence >= minimumConfidence
            ? 'pass'
            : 'blocked',
      value: confidence == null
        ? 'Not calculated'
        : minimumConfidence == null
          ? `${confidence}% · diagnostic`
          : `${confidence}% · minimum ${minimumConfidence}%`,
    },
    {
      label: 'Current confirmation step',
      state: progress.state,
      value: progress.label,
      detail: progress.detail,
    },
  ];
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ padding: '8px 9px', background: 'rgba(0,0,0,0.22)', borderRadius: 7 }}>
      <div style={{ fontSize: 9, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.6px' }}>{label}</div>
      <div style={{ marginTop: 3, fontSize: 12, color: 'var(--text)', fontWeight: 700, fontFamily: 'ui-monospace, monospace' }}>{value}</div>
    </div>
  );
}

function Confirmation({ item }: { item: ConfirmationItem }) {
  const presentation: Record<ConfirmationState, { label: string; foreground: string; background: string; border: string }> = {
    pass: { label: 'PASS', foreground: '#2dff7a', background: '#0d3320', border: '#1a5c38' },
    waiting: { label: 'WAITING', foreground: '#ffb347', background: '#3a2407', border: '#7a4d12' },
    blocked: { label: 'BLOCKED', foreground: '#ff7777', background: '#320d0d', border: '#5c1a1a' },
    not_evaluated: { label: 'NOT RUN', foreground: '#a5adba', background: '#171b22', border: '#343b47' },
    info: { label: 'INFO', foreground: '#66c7ff', background: '#102f48', border: '#24658f' },
  };
  const state = presentation[item.state];

  return (
    <div style={{ padding: '9px 10px', borderRadius: 7, background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.06)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
        <div style={{ color: 'var(--text)', fontSize: 11, fontWeight: 750 }}>{item.label}</div>
        <span style={{ padding: '3px 6px', borderRadius: 5, fontSize: 8, fontWeight: 900, letterSpacing: '0.45px', color: state.foreground, background: state.background, border: `1px solid ${state.border}`, whiteSpace: 'nowrap' }}>
          {state.label}
        </span>
      </div>
      <div style={{ marginTop: 5, color: '#d7dbea', fontSize: 10, lineHeight: 1.4, fontFamily: 'ui-monospace, monospace' }}>
        {item.value}
      </div>
      {item.detail && <div style={{ marginTop: 4, color: 'var(--muted)', fontSize: 9, lineHeight: 1.4 }}>{item.detail}</div>}
    </div>
  );
}

function progressButtonStyle(state: ConfirmationState) {
  if (state === 'pass') return { background: '#0d3320', border: '#1a5c38', color: '#2dff7a' };
  if (state === 'waiting') return { background: '#3a2407', border: '#7a4d12', color: '#ffb347' };
  if (state === 'blocked') return { background: '#320d0d', border: '#5c1a1a', color: '#ff7777' };
  return { background: '#171b22', border: '#343b47', color: '#c4cad4' };
}

function WatchCard({ signal, tier }: { signal: WatchSignal; tier: WatchTier }) {
  const [showConfirmations, setShowConfirmations] = useState(false);
  const hot = tier === 'hot';
  const direction = signal.direction === 'long' || signal.direction === 'short' ? signal.direction : 'neutral';
  const confidence = finite(signal.tpHitConfidence, signal.confidence);
  const v3Score = finite(signal.v3Score, signal.v3?.score, signal.score);
  const alignment = finite(signal.primaryTimeframeAlignment?.score, signal.alignment?.timeframeAlignmentScore);
  const rr = finite(signal.expectedRR, signal.rr, signal.riskReward);
  const fibonacci = signal.fibonacci || signal.v3?.fib;
  const confirmations = buildConfirmations(signal);
  const progress = progressSummary(signal);
  const buttonStyle = progressButtonStyle(progress.state);
  const checkedAt = confirmationTime(signal);
  const passedCount = confirmations.filter((item) => item.state === 'pass').length;
  const evaluatedCount = confirmations.filter((item) => item.state !== 'not_evaluated').length;

  return (
    <article style={{ padding: 16, borderRadius: 10, background: hot ? '#241400' : '#0b1b2b', border: hot ? '1px solid #7a4600' : '1px solid #1a4d73', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 17, fontWeight: 800, color: 'var(--text)' }}>{displayPair(signal)}</div>
          <div style={{ marginTop: 3, fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.7px' }}>{progress.label}</div>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ padding: '5px 9px', borderRadius: 6, background: hot ? '#4a2600' : '#102f48', border: hot ? '1px solid #a85d00' : '1px solid #24658f', color: hot ? '#ffb347' : '#66c7ff', fontSize: 11, fontWeight: 800 }}>
            {hot ? 'HOT WATCH' : 'NEAR QUALIFIED'}
          </span>
          {direction !== 'neutral' && (
            <span style={{ padding: '5px 9px', borderRadius: 6, background: direction === 'long' ? '#0d3320' : '#320d0d', border: direction === 'long' ? '1px solid #1a5c38' : '1px solid #5c1a1a', color: direction === 'long' ? '#2dff7a' : '#ff6666', fontSize: 11, fontWeight: 800 }}>
              {direction.toUpperCase()}
            </span>
          )}
        </div>
      </div>

      <p style={{ margin: 0, color: '#c7c7df', fontSize: 12, lineHeight: 1.55 }}>{watchReason(signal, tier)}</p>

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

      <button
        type="button"
        onClick={() => setShowConfirmations((current) => !current)}
        aria-expanded={showConfirmations}
        style={{ width: '100%', padding: '9px 11px', borderRadius: 7, background: buttonStyle.background, border: `1px solid ${buttonStyle.border}`, color: buttonStyle.color, fontFamily: 'inherit', fontSize: 10, fontWeight: 900, letterSpacing: '0.45px', textAlign: 'left', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}
      >
        <span>{progress.label}</span>
        <span>{showConfirmations ? 'HIDE CONFIRMATIONS' : 'VIEW CONFIRMATIONS'}</span>
      </button>

      <div style={{ color: 'var(--muted)', fontSize: 9, lineHeight: 1.4 }}>
        {progress.detail}
        {checkedAt ? ` Last native confirmation calculation: ${new Date(checkedAt).toLocaleString()}.` : ' No native Stage 1/2 calculation timestamp was returned.'}
      </div>

      {showConfirmations && (
        <div style={{ marginTop: 2, paddingTop: 10, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', marginBottom: 8 }}>
            <div style={{ color: 'var(--text)', fontSize: 12, fontWeight: 800 }}>Confirmation progress</div>
            <div style={{ color: 'var(--muted)', fontSize: 10, fontFamily: 'ui-monospace, monospace' }}>{passedCount} passed · {evaluatedCount}/{confirmations.length} evaluated</div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 7 }}>
            {confirmations.map((item) => <Confirmation key={item.label} item={item} />)}
          </div>
        </div>
      )}

      {signal.spreadPips != null && Number.isFinite(Number(signal.spreadPips)) && <div style={{ fontSize: 11, color: 'var(--muted)' }}>Current spread: {Number(signal.spreadPips).toFixed(1)} pips</div>}
    </article>
  );
}

function EmptyWatch({ tier }: { tier: WatchTier }) {
  return (
    <div style={{ padding: 18, background: 'var(--bg)', border: '1px dashed var(--border)', borderRadius: 8, color: 'var(--muted)', fontSize: 12, lineHeight: 1.5, textAlign: 'center' }}>
      {tier === 'hot' ? 'No pairs are currently waiting only on a trigger or retest.' : 'No pairs are currently close enough to retain as Near Qualified.'}
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
      if (!response.ok || data.ok !== true) throw new Error(data.error || `HTTP ${response.status}`);
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
          <p style={{ color: 'var(--muted)', margin: '5px 0 0', fontSize: 13, lineHeight: 1.5, maxWidth: 780 }}>
            Open each pair&apos;s progress button to see what was actually calculated, what passed, what failed, and what was not run. A missing native result is shown as NOT RUN rather than being described as an active wait.
          </p>
          {scannedAt && <div style={{ marginTop: 5, color: 'var(--muted)', fontSize: 11 }}>Watch scan completed {new Date(scannedAt).toLocaleString()}</div>}
        </div>
        <button type="button" onClick={() => void refresh()} disabled={!hasBroker || loading} style={{ padding: '8px 16px', background: hasBroker ? 'var(--bg)' : 'var(--border)', color: hasBroker ? 'var(--text)' : 'var(--muted)', border: '1px solid var(--border)', borderRadius: 6, fontFamily: 'inherit', fontWeight: 700, fontSize: 12, cursor: !hasBroker ? 'not-allowed' : loading ? 'wait' : 'pointer' }}>
          {loading ? 'Calculating confirmations…' : 'Refresh watch status'}
        </button>
      </div>

      {!hasBroker && <div style={{ padding: 18, background: 'var(--bg)', border: '1px dashed var(--border)', borderRadius: 8, textAlign: 'center', color: 'var(--muted)', fontSize: 12 }}>Connect a broker to scan Near Qualified and Hot Watch pairs.</div>}
      {error && <div style={{ padding: '10px 14px', background: '#320d0d', border: '1px solid #5c1a1a', borderRadius: 7, color: 'var(--bad)', fontSize: 12 }}><strong>Watch scan unavailable:</strong> {error}</div>}

      {hasBroker && !error && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(420px, 100%), 1fr))', gap: 14 }}>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <h3 style={{ margin: 0, color: '#ffb347', fontSize: 15 }}>Hot Watch</h3>
              <span style={{ color: '#ffb347', fontWeight: 800, fontSize: 13 }}>{hotWatch.length}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
              {hotWatch.length ? hotWatch.map((signal, index) => <WatchCard key={`hot:${signal.pair || signal.instrument}:${index}`} signal={signal} tier="hot" />) : <EmptyWatch tier="hot" />}
            </div>
          </div>

          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <h3 style={{ margin: 0, color: '#66c7ff', fontSize: 15 }}>Near Qualified / Analysis Incomplete</h3>
              <span style={{ color: '#66c7ff', fontWeight: 800, fontSize: 13 }}>{nearQualified.length}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
              {nearQualified.length ? nearQualified.map((signal, index) => <WatchCard key={`near:${signal.pair || signal.instrument}:${index}`} signal={signal} tier="near" />) : <EmptyWatch tier="near" />}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
