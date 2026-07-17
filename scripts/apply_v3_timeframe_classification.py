#!/usr/bin/env python3
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
ENTRY_PATH = ROOT / 'server' / 'v3EntryContract.js'
SCANNER_PATH = ROOT / 'server' / 'v3IndependentScanner.js'

entry = ENTRY_PATH.read_text(encoding='utf-8')

replacement = r'''export const V3_PRICE_BIAS_POLICY_VERSION = 'v3-price-action-trend-v2-2026-07-17';

function finitePriceCandle(candle = {}) {
  const open = Number(candle.open);
  const high = Number(candle.high);
  const low = Number(candle.low);
  const close = Number(candle.close);
  if (![open, high, low, close].every(Number.isFinite)) return null;
  if (high < low) return null;
  return { ...candle, open, high, low, close };
}

function average(values = []) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function regressionSlope(values = []) {
  if (values.length < 2) return 0;
  const xMean = (values.length - 1) / 2;
  const yMean = average(values);
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < values.length; index += 1) {
    const xDelta = index - xMean;
    numerator += xDelta * (values[index] - yMean);
    denominator += xDelta * xDelta;
  }
  return denominator > 0 ? numerator / denominator : 0;
}

/**
 * Native V3 price-action trend classification.
 *
 * The original classifier required an unusually clean HH/HL or LH/LL sequence,
 * then used a single five-candle displacement fallback. During normal market
 * conditions that made Daily, H4 and M15 all resolve to neutral across most or
 * all pairs. This policy combines independent price-action observations instead:
 * net displacement, rolling-close shift, regression slope, half-window market
 * structure and the latest close's location inside the observed range.
 *
 * It does not use the legacy scanner, EMA, RSI, MACD or legacy confidence.
 */
export function classifyPriceBias(candles = []) {
  if (!Array.isArray(candles)) return 'neutral';
  const valid = candles.map(finitePriceCandle).filter(Boolean);
  if (valid.length < 20) return 'neutral';

  const recent = valid.slice(-Math.min(30, valid.length));
  const closes = recent.map((candle) => candle.close);
  const ranges = recent.map((candle) => Math.max(0, candle.high - candle.low));
  const averageRange = average(ranges.filter((value) => value > 0));
  if (!Number.isFinite(averageRange) || averageRange <= 0) return 'neutral';

  const sample = Math.max(4, Math.floor(recent.length / 5));
  const firstCloseMean = average(closes.slice(0, sample));
  const lastCloseMean = average(closes.slice(-sample));
  const netChange = closes.at(-1) - closes[0];
  const rollingShift = lastCloseMean - firstCloseMean;
  const projectedSlope = regressionSlope(closes) * (closes.length - 1);

  const split = Math.floor(recent.length / 2);
  const prior = recent.slice(0, split);
  const current = recent.slice(split);
  const priorHigh = Math.max(...prior.map((candle) => candle.high));
  const priorLow = Math.min(...prior.map((candle) => candle.low));
  const currentHigh = Math.max(...current.map((candle) => candle.high));
  const currentLow = Math.min(...current.map((candle) => candle.low));
  const structureBuffer = averageRange * 0.05;
  const bullishStructure = currentHigh > priorHigh + structureBuffer && currentLow > priorLow + structureBuffer;
  const bearishStructure = currentHigh < priorHigh - structureBuffer && currentLow < priorLow - structureBuffer;

  const windowHigh = Math.max(...recent.map((candle) => candle.high));
  const windowLow = Math.min(...recent.map((candle) => candle.low));
  const windowRange = windowHigh - windowLow;
  const closeLocation = windowRange > 0 ? (closes.at(-1) - windowLow) / windowRange : 0.5;

  let bullishVotes = 0;
  let bearishVotes = 0;

  if (netChange >= averageRange * 0.4) bullishVotes += 1;
  if (netChange <= -averageRange * 0.4) bearishVotes += 1;
  if (rollingShift >= averageRange * 0.3) bullishVotes += 1;
  if (rollingShift <= -averageRange * 0.3) bearishVotes += 1;
  if (projectedSlope >= averageRange * 0.4) bullishVotes += 1;
  if (projectedSlope <= -averageRange * 0.4) bearishVotes += 1;
  if (bullishStructure) bullishVotes += 1;
  if (bearishStructure) bearishVotes += 1;
  if (closeLocation >= 0.6) bullishVotes += 1;
  if (closeLocation <= 0.4) bearishVotes += 1;

  if (bullishVotes >= 3 && bullishVotes > bearishVotes) return 'bullish';
  if (bearishVotes >= 3 && bearishVotes > bullishVotes) return 'bearish';
  if (bullishVotes >= 2 && bearishVotes === 0) return 'bullish';
  if (bearishVotes >= 2 && bullishVotes === 0) return 'bearish';
  return 'neutral';
}

export function derivePrimaryTimeframes'''

pattern = re.compile(
    r"export function classifyPriceBias\(candles = \[\]\) \{[\s\S]*?\n\}\n\nexport function derivePrimaryTimeframes"
)
if "V3_PRICE_BIAS_POLICY_VERSION" not in entry:
    matches = list(pattern.finditer(entry))
    if len(matches) != 1:
        raise RuntimeError(f'Expected one classifyPriceBias block, found {len(matches)}')
    entry = pattern.sub(replacement, entry, count=1)

required_markers = [
    "V3_PRICE_BIAS_POLICY_VERSION",
    "projectedSlope",
    "bullishVotes >= 3",
    "export function derivePrimaryTimeframes",
]
missing = [marker for marker in required_markers if marker not in entry]
if missing:
    raise RuntimeError('V3 timeframe classification patch incomplete: ' + ', '.join(missing))

ENTRY_PATH.write_text(entry, encoding='utf-8')

scanner = SCANNER_PATH.read_text(encoding='utf-8')
old = """      const candidate = buildIndependentV3Candidate({ pair, pricing, v3, newsRisk, session });
      if (!candidate) {
        const reasons = [
          ...(Array.isArray(v3?.rejectionReasons) ? v3.rejectionReasons : []),
          'Independent V3 could not build valid stop/target geometry of at least 1.5R',
        ];
        rejected.push(rejectionRecord({ pair, pricing, v3, reason: reasons[0], reasons }));
        continue;
      }
"""
new = """      const candidate = buildIndependentV3Candidate({ pair, pricing, v3, newsRisk, session });
      if (!candidate) {
        const nativeReasons = Array.isArray(v3?.rejectionReasons) ? v3.rejectionReasons : [];
        const candidateReason = !v3?.direction
          ? 'Independent V3 did not produce an executable Daily/H4 direction'
          : 'Independent V3 could not build valid stop/target geometry of at least 1.5R';
        const reasons = [...nativeReasons, candidateReason];
        rejected.push(rejectionRecord({ pair, pricing, v3, reason: reasons[0] || candidateReason, reasons }));
        continue;
      }
"""
if new not in scanner:
    if old not in scanner:
        raise RuntimeError('Independent V3 candidate rejection block not found')
    scanner = scanner.replace(old, new, 1)

SCANNER_PATH.write_text(scanner, encoding='utf-8')
print('Native V3 timeframe classification and rejection diagnostics applied.')
