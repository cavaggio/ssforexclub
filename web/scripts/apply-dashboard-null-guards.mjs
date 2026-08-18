import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(here, '..', 'components', 'scanner-status-card.tsx');
let source = fs.readFileSync(target, 'utf8');

function replaceOnce(oldText, newText, label) {
  if (source.includes(newText)) return;
  if (!source.includes(oldText)) {
    throw new Error(`Dashboard null-guard marker missing: ${label}`);
  }
  source = source.replace(oldText, newText);
}

// Reassessment payloads legitimately use null when a value cannot yet be
// calculated (for example, no original-risk geometry or no current TP/SL
// distance). `null !== undefined`, so the old guards still called toFixed()
// and crashed the complete dashboard route.
replaceOnce(
  "{trade.profitRMultiple !== undefined && (\n            <div style={{ fontSize: 12, color: '#888' }}>{trade.profitRMultiple.toFixed(2)}R</div>\n          )}",
  "{trade.profitRMultiple != null && (\n            <div style={{ fontSize: 12, color: '#888' }}>{trade.profitRMultiple.toFixed(2)}R</div>\n          )}",
  'reassessment profit-R null guard',
);
replaceOnce(
  '{trade.distanceToTP !== undefined && <SizingCell label="To TP" value={`${trade.distanceToTP.toFixed(1)}p`} />}',
  '{trade.distanceToTP != null && <SizingCell label="To TP" value={`${trade.distanceToTP.toFixed(1)}p`} />}',
  'reassessment TP-distance null guard',
);
replaceOnce(
  '{trade.distanceToSL !== undefined && <SizingCell label="To SL" value={`${trade.distanceToSL.toFixed(1)}p`} />}',
  '{trade.distanceToSL != null && <SizingCell label="To SL" value={`${trade.distanceToSL.toFixed(1)}p`} />}',
  'reassessment SL-distance null guard',
);

// Active-trade analysis is broker-derived. Treat every formatted number as
// nullable at the UI boundary even where the TypeScript contract historically
// declared it as required. A single incomplete OANDA analysis row must degrade
// to an em dash rather than unmounting /dashboard.
replaceOnce(
  "            ${trade.unrealizedPL.toFixed(2)}",
  "            {trade.unrealizedPL == null ? '—' : `$${trade.unrealizedPL.toFixed(2)}`}",
  'active unrealized P/L null guard',
);
replaceOnce(
  "            unrealized · {trade.unrealizedPips >= 0 ? '+' : ''}\n            {trade.unrealizedPips.toFixed(1)} pips",
  "            unrealized · {trade.unrealizedPips == null ? '—' : `${trade.unrealizedPips >= 0 ? '+' : ''}${trade.unrealizedPips.toFixed(1)} pips`}",
  'active unrealized pips null guard',
);
replaceOnce(
  '<PriceCell label="Entry" value={trade.entryPrice.toFixed(5)} color="#e0e0ff" />',
  '<PriceCell label="Entry" value={trade.entryPrice == null ? \'—\' : trade.entryPrice.toFixed(5)} color="#e0e0ff" />',
  'active entry-price null guard',
);
replaceOnce(
  '<PriceCell label="Current" value={trade.currentPrice.toFixed(5)} color={plColor} />',
  '<PriceCell label="Current" value={trade.currentPrice == null ? \'—\' : trade.currentPrice.toFixed(5)} color={plColor} />',
  'active current-price null guard',
);
replaceOnce(
  'sub={`${trade.distanceToSLPips.toFixed(1)}p away`}',
  'sub={trade.distanceToSLPips == null ? \'—\' : `${trade.distanceToSLPips.toFixed(1)}p away`}',
  'active SL-distance null guard',
);
replaceOnce(
  'sub={`${trade.distanceToTPPips.toFixed(1)}p to go (${(trade.tpProgress * 100).toFixed(0)}%)`}',
  'sub={trade.distanceToTPPips == null || trade.tpProgress == null ? \'—\' : `${trade.distanceToTPPips.toFixed(1)}p to go (${(trade.tpProgress * 100).toFixed(0)}%)`}',
  'active TP-distance/progress null guard',
);
replaceOnce(
  '<SizingCell label="TP prob" value={`${(trade.tpProbability * 100).toFixed(0)}%`} />',
  '<SizingCell label="TP prob" value={trade.tpProbability == null ? \'—\' : `${(trade.tpProbability * 100).toFixed(0)}%`} />',
  'active TP-probability null guard',
);
replaceOnce(
  '<SizingCell label="SL prob" value={`${(trade.slProbability * 100).toFixed(0)}%`} />',
  '<SizingCell label="SL prob" value={trade.slProbability == null ? \'—\' : `${(trade.slProbability * 100).toFixed(0)}%`} />',
  'active SL-probability null guard',
);
replaceOnce(
  'id {trade.tradeId} · open {trade.minutesElapsed} min ago · {trade.units.toLocaleString()} units',
  "id {trade.tradeId} · open {trade.minutesElapsed} min ago · {trade.units == null ? '—' : Number(trade.units).toLocaleString()} units",
  'active units null guard',
);

// Rejected rows may also carry a null spread when pricing is unavailable.
replaceOnce(
  "{sig.spreadPips !== undefined && <span style={{ color: '#ff8c00' }}>Spread: {sig.spreadPips.toFixed(1)}p</span>}",
  "{sig.spreadPips != null && <span style={{ color: '#ff8c00' }}>Spread: {sig.spreadPips.toFixed(1)}p</span>}",
  'rejected spread null guard',
);

for (const forbidden of [
  'trade.profitRMultiple !== undefined',
  'trade.distanceToTP !== undefined && <SizingCell label="To TP"',
  'trade.distanceToSL !== undefined && <SizingCell label="To SL"',
  'sub={`${trade.distanceToSLPips.toFixed(1)}p away`}',
  'sub={`${trade.distanceToTPPips.toFixed(1)}p to go',
  '<SizingCell label="TP prob" value={`${(trade.tpProbability * 100).toFixed(0)}%`} />',
  '<SizingCell label="SL prob" value={`${(trade.slProbability * 100).toFixed(0)}%`} />',
  'sig.spreadPips !== undefined && <span',
]) {
  if (source.includes(forbidden)) {
    throw new Error(`Dashboard null-guard verification failed: ${forbidden}`);
  }
}

for (const required of [
  'trade.profitRMultiple != null',
  'trade.distanceToTP != null',
  'trade.distanceToSL != null',
  "trade.unrealizedPL == null ? '—'",
  "trade.tpProbability == null ? '—'",
  "trade.slProbability == null ? '—'",
]) {
  if (!source.includes(required)) {
    throw new Error(`Dashboard null-guard verification incomplete: ${required}`);
  }
}

fs.writeFileSync(target, source);
console.log('Dashboard numeric rendering guarded against null broker/reassessment values.');
