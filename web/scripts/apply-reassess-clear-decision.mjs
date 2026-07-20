import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(here, '..', 'components', 'scanner-status-card.tsx');
let source = fs.readFileSync(target, 'utf8');

const typeAnchor = `  lifecycleRecommendation?: {
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
  error?: string;`;

const expandedType = `  lifecycleRecommendation?: {
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
    autoCloseCandidate?: boolean;
    autoCloseReviewTriggered?: boolean;
    confidenceThreshold?: number;
    confidenceBelowThreshold?: boolean;
    signalMisaligned?: boolean;
    signalMisalignmentReasons?: string[];
  };
  initialConfidence?: number | null;
  confidenceReviewThreshold?: number;
  confidenceBelowReviewThreshold?: boolean;
  signalMisaligned?: boolean;
  signalMisalignmentReasons?: string[];
  institutionalFlow?: {
    detected: boolean;
    direction: string;
    aligned: boolean;
    opposes: boolean;
    reason?: string | null;
    signals?: string[];
  };
  marketMovement?: {
    currentPrice?: number;
    entryPrice?: number;
    profitPips?: number;
    profitR?: number | null;
    m15Trend?: string;
    candleStrengthScore?: number;
    velocityScore?: number;
    momentumStatus?: string;
  };
  autoCloseAnalysis?: {
    evaluated: boolean;
    candidate: boolean;
    enabled: boolean;
    shouldAutoClose: boolean;
    threshold: number;
    triggers: string[];
  };
  error?: string;`;

if (!source.includes(expandedType)) {
  if (!source.includes(typeAnchor)) throw new Error('ReassessTrade type anchor not found');
  source = source.replace(typeAnchor, expandedType);
}

const startMarker = '// ─── 30-min reassessment card ─────────────────────────────────────────────────';
const endMarker = '// ─── Section helpers ──────────────────────────────────────────────────────────';
const start = source.indexOf(startMarker);
const end = source.indexOf(endMarker);
if (start < 0 || end < 0 || end <= start) throw new Error('Reassessment card section markers not found');

const replacement = `// ─── 30-min reassessment card ─────────────────────────────────────────────────

function recommendationLabel(action: string): string {
  switch (action) {
    case 'close': return 'CLOSE POSITION';
    case 'partial_close': return 'PARTIAL CLOSE';
    case 'tighten_sl': return 'TIGHTEN STOP';
    case 'reduce_tp': return 'REDUCE TARGET';
    case 'expand_tp': return 'EXTEND TARGET';
    default: return 'HOLD POSITION';
  }
}

function recommendationTone(action: string, urgency: string): BadgeType {
  if (action === 'close' || urgency === 'high') return 'bad';
  if (action === 'partial_close' || urgency === 'medium') return 'warn';
  if (action === 'hold') return 'good';
  return 'info';
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

  const decision = trade.lifecycleRecommendation ?? {
    action: 'hold' as const,
    reason: 'No current market-management recommendation was returned.',
    urgency: 'low' as const,
    confidence: trade.currentConfidence ?? 0,
    suggestedNewSL: null,
    suggestedNewTP: trade.recommendedTakeProfit ?? 0,
    shouldAutoClose: false,
    autoCloseReason: null,
  };
  const actionLabel = recommendationLabel(decision.action);
  const actionTone = recommendationTone(decision.action, decision.urgency);
  const pl = trade.currentPnL ?? 0;
  const plColor = pl >= 0 ? '#2dff7a' : '#ff4d4d';
  const threshold = trade.confidenceReviewThreshold ?? decision.confidenceThreshold ?? 70;
  const confidence = trade.currentConfidence;
  const belowConfidence = trade.confidenceBelowReviewThreshold ??
    (confidence !== undefined && confidence < threshold);
  const flow = trade.institutionalFlow;
  const flowLabel = flow?.opposes
    ? 'OPPOSING'
    : flow?.aligned
      ? 'ALIGNED'
      : flow?.detected
        ? String(flow.direction || 'neutral').toUpperCase()
        : 'NO CLEAR FLOW';
  const flowTone: BadgeType = flow?.opposes ? 'bad' : flow?.aligned ? 'good' : 'neutral';
  const misalignmentReasons = trade.signalMisalignmentReasons ?? decision.signalMisalignmentReasons ?? [];
  const autoClose = trade.autoCloseAnalysis;
  const manualCloseReason = decision.unifiedSummary ?? decision.reason ?? 'Manual close requested from reassessment card.';
  const partialPercent = trade.partialClose?.recommendedPartialClosePercent ?? trade.partialExitPercent ?? 0;

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
          <Badge value={actionLabel} type={actionTone} />
          <Badge value={decision.urgency.toUpperCase()} type={decision.urgency === 'high' ? 'bad' : decision.urgency === 'medium' ? 'warn' : 'neutral'} />
          {autoClose?.evaluated && <Badge value="AUTO-CLOSE REVIEWED" type={autoClose.candidate ? 'bad' : 'info'} />}
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 18, color: plColor, fontWeight: 800 }}>
            {pl < 0 ? '-' : ''}\${Math.abs(pl).toFixed(2)}
          </div>
          {trade.profitRMultiple !== undefined && (
            <div style={{ fontSize: 12, color: '#888' }}>{trade.profitRMultiple.toFixed(2)}R</div>
          )}
        </div>
      </div>

      <div
        style={{
          marginTop: 12,
          padding: '14px 16px',
          borderRadius: 9,
          border: decision.action === 'close' ? '1px solid #ff4d4d' : decision.urgency === 'medium' ? '1px solid #5c4600' : '1px solid #1a5c38',
          background: decision.action === 'close' ? '#250b0b' : decision.urgency === 'medium' ? '#211a00' : '#0b2014',
        }}
      >
        <div style={{ color: '#888', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.8px', fontWeight: 700 }}>
          Current market decision
        </div>
        <div style={{ marginTop: 4, fontSize: 19, fontWeight: 900, color: decision.action === 'close' ? '#ff7777' : decision.action === 'hold' ? '#61ff98' : '#ffcc66' }}>
          {actionLabel}
        </div>
        <div style={{ marginTop: 6, color: '#ddd', fontSize: 13, lineHeight: 1.55 }}>
          {decision.unifiedSummary ?? decision.reason}
        </div>
        <div style={{ marginTop: 6, color: '#888', fontSize: 12 }}>
          Recommendation confidence {decision.confidence}% · source {String(decision.source || 'market lifecycle').replace(/_/g, ' ')}
        </div>
      </div>

      <div style={{ ...s.sizingGrid, marginTop: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))' }}>
        {confidence !== undefined && <SizingCell label="Live confidence" value={\`\${confidence}%\`} />}
        <SizingCell label="Close-review floor" value={\`\${threshold}%\`} />
        {trade.initialConfidence != null && <SizingCell label="Entry confidence" value={\`\${trade.initialConfidence}%\`} />}
        {trade.currentAlignmentScore !== undefined && <SizingCell label="Alignment" value={\`\${trade.currentAlignmentScore}/100\`} />}
        {trade.multiTimeframeAlignmentScore !== undefined && <SizingCell label="MTF alignment" value={\`\${trade.multiTimeframeAlignmentScore}/100\`} />}
        <SizingCell label="Institutional flow" value={flowLabel} />
        {trade.marketState && <SizingCell label="Market state" value={trade.marketState} />}
        {trade.candleStrengthScore !== undefined && <SizingCell label="Candle strength" value={\`\${trade.candleStrengthScore}/100\`} />}
        {trade.velocityScore !== undefined && <SizingCell label="Velocity" value={\`\${trade.velocityScore}/100\`} />}
        {trade.momentumStatus && <SizingCell label="Momentum" value={trade.momentumStatus} />}
        {trade.distanceToTP !== undefined && <SizingCell label="To TP" value={\`\${trade.distanceToTP.toFixed(1)}p\`} />}
        {trade.distanceToSL !== undefined && <SizingCell label="To SL" value={\`\${trade.distanceToSL.toFixed(1)}p\`} />}
        {trade.minutesElapsed !== undefined && <SizingCell label="Elapsed" value={\`\${trade.minutesElapsed}m\`} />}
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <Badge value={belowConfidence ? \`CONFIDENCE < \${threshold}%\` : \`CONFIDENCE ≥ \${threshold}%\`} type={belowConfidence ? 'bad' : 'good'} />
        <Badge value={flowLabel} type={flowTone} />
        <Badge value={trade.signalMisaligned ? 'SIGNAL MISALIGNED' : 'SIGNAL ALIGNED'} type={trade.signalMisaligned ? 'bad' : 'good'} />
      </div>

      {misalignmentReasons.length > 0 && (
        <div style={{ marginTop: 10, padding: '10px 12px', border: '1px solid #5c1a1a', background: '#260d0d', borderRadius: 8, color: '#ffaaaa', fontSize: 12, lineHeight: 1.55 }}>
          <strong>What changed from entry:</strong> {misalignmentReasons.join(' · ')}
        </div>
      )}

      {flow?.reason && (
        <div style={{ marginTop: 8, padding: '9px 12px', border: '1px solid #1b3150', background: '#091522', borderRadius: 8, color: '#9dcbff', fontSize: 12, lineHeight: 1.5 }}>
          <strong>Institutional-flow read:</strong> {flow.reason}
        </div>
      )}

      {autoClose?.evaluated && (
        <div style={{ marginTop: 10, padding: '10px 12px', border: autoClose.candidate ? '1px solid #ff4d4d' : '1px solid #1b4060', background: autoClose.candidate ? '#250b0b' : '#091522', borderRadius: 8, color: autoClose.candidate ? '#ffaaaa' : '#9dcbff', fontSize: 12, lineHeight: 1.55 }}>
          <strong>Auto-close analysis:</strong>{' '}
          {autoClose.shouldAutoClose
            ? 'Automatic close criteria are met and auto-close is enabled.'
            : autoClose.candidate
              ? 'A close opportunity is detected. Automatic closing is not authorized for this event, so use the manual Close Trade button or enable the auto-close guard.'
              : 'The bot reviewed a possible close but current evidence does not justify an automatic exit.'}
          {autoClose.triggers?.length ? \` Triggers: \${autoClose.triggers.join(' · ')}\` : ''}
        </div>
      )}

      {(decision.action === 'tighten_sl' && decision.suggestedNewSL != null) && (
        <div style={{ ...s.factorsBox, marginTop: 10 }}>
          <span style={{ color: '#888' }}>Recommended stop:</span>{' '}
          <span style={{ color: '#ffcc66', fontWeight: 700 }}>{decision.suggestedNewSL}</span>
        </div>
      )}
      {(['reduce_tp', 'expand_tp'].includes(decision.action) && decision.suggestedNewTP != null) && (
        <div style={{ ...s.factorsBox, marginTop: 10 }}>
          <span style={{ color: '#888' }}>Recommended target:</span>{' '}
          <span style={{ color: '#61ff98', fontWeight: 700 }}>{decision.suggestedNewTP}</span>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <CloseTradeButton
          tradeId={trade.tradeId}
          instrument={trade.instrument}
          totalUnits={Math.max(1, Math.abs(Number(trade.units ?? 1)))}
          unrealizedPL={trade.currentPnL}
          direction={trade.direction}
          mode="close"
          reason={manualCloseReason}
          isLive={isLive}
          onAfter={onAfterClose}
        />
        {decision.action === 'partial_close' && partialPercent > 0 && (
          <CloseTradeButton
            tradeId={trade.tradeId}
            instrument={trade.instrument}
            totalUnits={Math.max(1, Math.abs(Number(trade.units ?? 1)))}
            unrealizedPL={trade.currentPnL}
            direction={trade.direction}
            mode="partial_close"
            partialPercent={partialPercent}
            reason={manualCloseReason}
            isLive={isLive}
            onAfter={onAfterClose}
          />
        )}
      </div>
    </div>
  );
}

`;

source = source.slice(0, start) + replacement + source.slice(end);

for (const marker of [
  'Current market decision',
  'Institutional-flow read:',
  'Auto-close analysis:',
  'mode="close"',
  'Close-review floor',
]) {
  if (!source.includes(marker)) throw new Error(`Reassessment card patch incomplete: ${marker}`);
}

fs.writeFileSync(target, source);
console.log('30-minute reassessment card now shows one live market decision and an always-available manual close button.');
