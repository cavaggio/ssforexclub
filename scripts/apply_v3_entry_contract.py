#!/usr/bin/env python3
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]


def read(path):
    return (ROOT / path).read_text()


def write(path, text):
    (ROOT / path).write_text(text)


def replace_once(text, old, new, label):
    if new in text:
        return text
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, found {count}")
    return text.replace(old, new, 1)


def replace_all_required(text, old, new, minimum, label):
    if new in text and old not in text:
        return text
    count = text.count(old)
    if count < minimum:
        raise RuntimeError(f"{label}: expected at least {minimum} matches, found {count}")
    return text.replace(old, new)


def regex_once(text, pattern, replacement, label, flags=0):
    compiled = re.compile(pattern, flags)
    matches = list(compiled.finditer(text))
    if not matches:
        if replacement in text:
            return text
        raise RuntimeError(f"{label}: no match")
    if len(matches) != 1:
        raise RuntimeError(f"{label}: expected one regex match, found {len(matches)}")
    return compiled.sub(replacement, text, count=1)


# ---------------------------------------------------------------------------
# Daily/H4 must both align; M15 determines whether score is 67 or 100.
# ---------------------------------------------------------------------------
path = 'server/primaryTimeframeAlignment.js'
text = read(path)
text = text.replace(
    'Two of the three aligned with the intended direction = 67/100 and PASS.',
    'Daily and H4 must both align with the intended direction. That hard pair scores 67/100; aligned M15 raises the score to 100/100.',
)
text = text.replace(
    "export const PRIMARY_ALIGNMENT_POLICY_VERSION = 'v3-primary-2of3-2026-07-14';",
    "export const PRIMARY_ALIGNMENT_POLICY_VERSION = 'v3-primary-daily-h4-hard-2026-07-16';",
)
text = replace_once(
    text,
    "  const score = scores[alignedTimeframes.length] ?? 0;\n  const passed = score >= PRIMARY_ALIGNMENT_MIN_SCORE;",
    "  const score = scores[alignedTimeframes.length] ?? 0;\n  const dailyH4Aligned = biases.daily === expected && biases.h4 === expected;\n  const passed = dailyH4Aligned && score >= PRIMARY_ALIGNMENT_MIN_SCORE;",
    'primary hard Daily/H4 gate',
)
text = replace_once(
    text,
    "  if (!passed) {\n    reason =\n      `Primary timeframe alignment failed: Daily/H4/M15 score ${score}/100 < ` +\n      `${PRIMARY_ALIGNMENT_MIN_SCORE}/100 for ${expected}.`;",
    "  if (!passed) {\n    reason = dailyH4Aligned\n      ? `Primary timeframe alignment failed: Daily/H4/M15 score ${score}/100 < ${PRIMARY_ALIGNMENT_MIN_SCORE}/100 for ${expected}.`\n      : `Primary timeframe alignment failed: Daily and H4 must both align with ${expected}; Daily=${biases.daily}, H4=${biases.h4}.`;",
    'primary rejection reason',
)
text = replace_once(
    text,
    "    minimumScore: PRIMARY_ALIGNMENT_MIN_SCORE,\n    primaryTimeframes:",
    "    minimumScore: PRIMARY_ALIGNMENT_MIN_SCORE,\n    dailyH4Aligned,\n    primaryTimeframes:",
    'primary metrics',
)
write(path, text)

# ---------------------------------------------------------------------------
# V3 derives executable direction from the hard Daily/H4 pair and exposes all
# three required timeframe classifications.
# ---------------------------------------------------------------------------
path = 'server/v3Engine.js'
text = read(path)
text = replace_once(
    text,
    "import { getPipSize } from './pipMath.js';",
    "import { getPipSize } from './pipMath.js';\nimport { evaluatePrimaryTimeframeAlignment } from './primaryTimeframeAlignment.js';\nimport { derivePrimaryTimeframes, directionFromDailyH4 } from './v3EntryContract.js';",
    'v3 timeframe imports',
)
text = replace_once(
    text,
    "  const price = Number.isFinite(currentPrice)\n    ? currentPrice\n    : (m15Candles.length ? m15Candles[m15Candles.length - 1].close : null);\n\n  const liquidity",
    "  const price = Number.isFinite(currentPrice)\n    ? currentPrice\n    : (m15Candles.length ? m15Candles[m15Candles.length - 1].close : null);\n\n  const timeframes = derivePrimaryTimeframes({ dailyCandles, h4Candles, m15Candles });\n  const direction = directionFromDailyH4(timeframes);\n  const primaryTimeframeAlignment = evaluatePrimaryTimeframeAlignment({ timeframes }, direction);\n\n  const liquidity",
    'v3 timeframe derivation',
)
text = replace_once(
    text,
    "  const direction = deriveDirection({ structure, liquidity, session });",
    "  const structureDirection = deriveDirection({ structure, liquidity, session });",
    'v3 structure direction diagnostic',
)
text = replace_once(
    text,
    "    direction: scored.direction,\n    legacyDirection,",
    "    direction: primaryTimeframeAlignment.passed ? scored.direction : null,\n    structureDirection,\n    timeframes,\n    primaryTimeframeAlignment,\n    legacyDirection,",
    'v3 return alignment fields',
)
text = replace_once(
    text,
    "    qualified: scored.qualified,\n    earlyTrigger: scored.earlyTrigger,\n    rejectionReasons: scored.rejectionReasons,",
    "    qualified: scored.qualified && primaryTimeframeAlignment.passed,\n    earlyTrigger: scored.earlyTrigger,\n    rejectionReasons: [\n      ...scored.rejectionReasons,\n      ...(primaryTimeframeAlignment.passed ? [] : [primaryTimeframeAlignment.reason]),\n    ],",
    'v3 alignment qualification',
)
write(path, text)

# ---------------------------------------------------------------------------
# Stamp sweep/BOS/CHoCH events so an opposing sweep can only be overridden by
# a demonstrably newer reversal event.
# ---------------------------------------------------------------------------
path = 'server/oandaInstitutionalFlow.js'
text = read(path)
text = replace_all_required(
    text,
    "        direction: 'bearish',\n        sweptPriceLevel:",
    "        direction: 'bearish',\n        time: last.time || null,\n        sweptPriceLevel:",
    2,
    'bearish sweep timestamps',
)
text = replace_all_required(
    text,
    "        direction: 'bullish',\n        sweptPriceLevel:",
    "        direction: 'bullish',\n        time: last.time || null,\n        sweptPriceLevel:",
    2,
    'bullish sweep timestamps',
)
text = replace_all_required(
    text,
    "        direction: 'bullish',\n        brokenLevel:",
    "        direction: 'bullish',\n        time: last.time || null,\n        brokenLevel:",
    2,
    'bullish structure timestamps',
)
text = replace_all_required(
    text,
    "        direction: 'bearish',\n        brokenLevel:",
    "        direction: 'bearish',\n        time: last.time || null,\n        brokenLevel:",
    2,
    'bearish structure timestamps',
)
write(path, text)

# ---------------------------------------------------------------------------
# Stage 2 is the final market-state confirmation. Stage 3 is removed entirely.
# ---------------------------------------------------------------------------
path = 'server/v3QualityConfirmation.js'
text = read(path)
text = replace_once(
    text,
    "import {\n  computeV3EntryTpHitConfidence,\n  computeV3TpHitConfidence,\n} from './v3TpConfidence.js';",
    "import { computeV3EntryTpHitConfidence } from './v3TpConfidence.js';\nimport { evaluatePrimaryTimeframeAlignment } from './primaryTimeframeAlignment.js';\nimport { evaluateStage2EntryContract } from './v3EntryContract.js';",
    'quality imports',
)
text = text.replace('Three-stage V3 quality confirmation.', 'Two-stage V3 quality confirmation.')
text = text.replace(
    " * Stage 3: Immediately before order submission, is the signal still fresh and\n *          geometrically valid at the current executable price?\n",
    '',
)
text = replace_once(
    text,
    "  const pair = signal.pair || v3.pair || null;\n  const score =",
    "  const pair = signal.pair || v3.pair || null;\n  const alignment = evaluatePrimaryTimeframeAlignment(v3, direction);\n  const score =",
    'quality setup alignment',
)
text = replace_once(
    text,
    "  if (!direction) reasons.push('missing V3 direction');\n  if (score < minScore)",
    "  if (!direction) reasons.push('missing V3 direction');\n  if (!alignment.passed) reasons.push(alignment.reason);\n  if (score < minScore)",
    'quality setup alignment reason',
)
text = replace_once(
    text,
    "      direction,\n      score,",
    "      direction,\n      alignment,\n      score,",
    'quality setup alignment metrics',
)
text = replace_once(
    text,
    "  const direction = normalizeDirection(signal.direction || v3.direction || v3.signal);\n  const sweep = confirmedAlignedSweep(v3, direction);",
    "  const direction = normalizeDirection(signal.direction || v3.direction || v3.signal);\n  const entryContract = evaluateStage2EntryContract(signal);\n  const sweep = confirmedAlignedSweep(v3, direction);",
    'quality stage2 entry contract',
)
text = replace_once(
    text,
    "  const minSupports = envNumber('V3_QUALITY_TRIGGER_MIN_SUPPORTS', 1);\n  const reasons = [];",
    "  const minSupports = envNumber('V3_QUALITY_TRIGGER_MIN_SUPPORTS', 1);\n  const reasons = [...entryContract.reasons];",
    'quality stage2 reasons',
)
text = replace_once(
    text,
    "      direction,\n      pendingSweep:",
    "      direction,\n      alignment: entryContract.alignment,\n      entryTiming: entryContract.entryTiming,\n      sweepBlock: entryContract.sweepBlock,\n      reversal: entryContract.reversal,\n      lockedDirection: entryContract.lockedDirection,\n      pendingSweep:",
    'quality stage2 contract metrics',
)
text = regex_once(
    text,
    r"\nfunction parseTimestamp\(value\) \{[\s\S]*?\nexport const _test = \{",
    "\nexport const _test = {",
    'remove Stage 3 function',
)
write(path, text)

# ---------------------------------------------------------------------------
# Every independent candidate receives entryTiming, and execution refreshes the
# same pair through Stage 1/Stage 2 immediately before order submission.
# ---------------------------------------------------------------------------
path = 'server/v3IndependentScanner.js'
text = read(path)
text = replace_once(
    text,
    "import { computeV3EntryTpHitConfidence } from './v3TpConfidence.js';",
    "import { computeV3EntryTpHitConfidence } from './v3TpConfidence.js';\nimport { deriveV3EntryTiming, validateDirectionLock } from './v3EntryContract.js';",
    'independent entry contract import',
)
text = replace_once(
    text,
    "  const tpHitConfidence = computeV3EntryTpHitConfidence(candidate);",
    "  candidate.entryTiming = deriveV3EntryTiming(candidate);\n  candidate.v3.entryTiming = candidate.entryTiming;\n\n  const tpHitConfidence = computeV3EntryTpHitConfidence(candidate);",
    'independent candidate timing',
)
text = replace_once(
    text,
    "      candidate.qualityConfirmation = {\n        stage1,\n        stage2,\n        checkedAt: new Date().toISOString(),\n      };",
    "      candidate.qualityConfirmation = {\n        stage1,\n        stage2,\n        checkedAt: new Date().toISOString(),\n      };\n      candidate.directionLock = {\n        candidateDirection: candidate.direction,\n        confirmedDirection: stage2.metrics?.lockedDirection || stage2.metrics?.direction || candidate.direction,\n        freshDirection: stage2.metrics?.direction || candidate.direction,\n        stage2CheckedAt: stage2.checkedAt,\n      };",
    'independent direction lock',
)
if 'export async function refreshIndependentV3CandidateForExecution' not in text:
    text += """

export async function refreshIndependentV3CandidateForExecution({ candidate, client, now = new Date(), log = () => {} } = {}) {
  const pair = candidate?.pair;
  if (!pair) return { allowed: false, reason: 'execution refresh missing pair', candidate: null };

  const refreshScan = await scanV3IndependentMarket({
    pairs: [pair],
    client,
    now,
    scanMode: 'stage2_execution_refresh',
    log,
  });
  const freshCandidate = refreshScan.qualified.find((item) => item.pair === pair) || null;
  if (!freshCandidate) {
    const rejection = refreshScan.rejected.find((item) => item.pair === pair);
    return {
      allowed: false,
      reason: rejection?.rejectionReasons?.join('; ') || rejection?.reason || 'fresh Stage 2 confirmation failed',
      candidate: null,
      refreshScan,
    };
  }

  const lock = validateDirectionLock({
    candidateDirection: candidate.direction,
    confirmedDirection: candidate.qualityConfirmation?.stage2?.metrics?.lockedDirection || candidate.directionLock?.confirmedDirection || candidate.direction,
    freshDirection: freshCandidate.direction,
  });
  if (!lock.allowed) {
    return { allowed: false, reason: lock.reasons.join('; '), candidate: null, refreshScan, directionLock: lock };
  }

  freshCandidate.directionLock = {
    candidateDirection: lock.candidateDirection,
    confirmedDirection: lock.confirmedDirection,
    freshDirection: lock.freshDirection,
    stage2CheckedAt: freshCandidate.qualityConfirmation?.stage2?.checkedAt || new Date().toISOString(),
  };
  return { allowed: true, reason: null, candidate: freshCandidate, refreshScan, directionLock: lock };
}
"""
write(path, text)

# ---------------------------------------------------------------------------
# Auto V3 performs the fresh Stage 2 refresh and never silently changes sides.
# ---------------------------------------------------------------------------
path = 'server/v3AutoTrade.js'
text = read(path)
text = replace_once(
    text,
    "import { scanV3IndependentMarket } from './v3IndependentScanner.js';",
    "import { scanV3IndependentMarket, refreshIndependentV3CandidateForExecution } from './v3IndependentScanner.js';",
    'auto V3 refresh import',
)
text = replace_once(
    text,
    "  for (const signal of qualified) {\n    signal.environment = client?.environment || signal.environment;\n    const result = await executeTrade(signal, { client, autoAi: true });",
    "  for (let signal of qualified) {\n    const refreshed = await refreshIndependentV3CandidateForExecution({ candidate: signal, client, now: new Date(), log });\n    if (!refreshed.allowed) {\n      skipped.push({ pair: signal.pair, direction: signal.direction, reason: refreshed.reason });\n      log(`execution skipped pair=${signal.pair} dir=${signal.direction} reason=\"${refreshed.reason}\"`);\n      continue;\n    }\n    signal = applyScalpMetadata({\n      ...signal,\n      ...refreshed.candidate,\n      source: 'v3_pure_auto_ai',\n      strategy: 'V3',\n      engine: 'v3',\n      tradeStyle: 'SCALP',\n      scalpOnly: true,\n      selectedLogicType: 'v3_pure',\n      architecture: 'independent_v3_raw_market_data',\n      legacyScannerUsed: false,\n      legacyDirection: null,\n      sharedRetraceWatchUsed: false,\n    });\n    signal.environment = client?.environment || signal.environment;\n    const result = await executeTrade(signal, { client, autoAi: true });",
    'auto V3 execution refresh',
)
write(path, text)

# ---------------------------------------------------------------------------
# Universal entry policy requires one of the five explicit timing states and
# only valid_entry may execute. Opposing confirmed sweeps are hard blocks.
# ---------------------------------------------------------------------------
write('server/executionPolicy.js', """import { ENTRY_TIMING_STATUSES, evaluateOpposingSweepBlock } from './v3EntryContract.js';

const ALLOWED_TIMING = new Set(ENTRY_TIMING_STATUSES);

function firstText(...values) {
  return values.find((value) => typeof value === 'string' && value.trim())?.trim() || '';
}
function firstNumber(...values) {
  for (const value of values) { const n = Number(value); if (Number.isFinite(n)) return n; }
  return null;
}
function extractV3(signal = {}) { return signal.v3 || signal.v3Eval || signal.v3Analysis || signal.metadata?.v3 || {}; }
function timingStatus(signal = {}) {
  return firstText(signal.entryTiming?.status, signal.timingStatus, signal.v3?.entryTiming?.status).toLowerCase();
}
function pendingSweep(signal = {}) {
  const v3 = extractV3(signal); const sweep = v3.liquidity?.liquiditySweep || signal.liquiditySweep || {};
  return sweep.pending === true || String(sweep.subtype || '').toLowerCase() === 'pending_sweep';
}
function rangeState(signal = {}) {
  const v3 = extractV3(signal); const structure = v3.structure || signal.structure || {}; const regime = v3.marketRegime || signal.marketRegime || {};
  const state = firstText(signal.marketState, signal.regime, regime.regime, regime.state, structure.marketState, structure.structureTrend).toLowerCase();
  return state.includes('rang') || state.includes('consolidat') || state.includes('choppy') || state.includes('whipsaw');
}
function confirmedBreakoutRetest(signal = {}, direction) {
  const v3 = extractV3(signal); const structure = v3.structure || signal.structure || {}; const timing = signal.entryTiming || {};
  const sign = direction === 'long' ? 'bullish' : direction === 'short' ? 'bearish' : null;
  const breakDirection = firstText(signal.rangeBreakout?.direction, structure.breakoutDirection, structure.bos?.direction, structure.choch?.direction).toLowerCase();
  const closeOutside = signal.rangeBreakout?.closeOutside === true || structure.closeOutsideRange === true || structure.rangeBreakConfirmed === true;
  const retest = timing.retestDetected === true && timing.status === 'valid_entry';
  return closeOutside && retest && (!breakDirection || breakDirection === sign);
}
export function setupFingerprint(signal = {}, accountId = '') {
  const v3 = extractV3(signal); const structure = v3.structure || signal.structure || {}; const liquidity = v3.liquidity || signal.liquidity || {};
  const triggerTime = firstText(signal.triggerCandleTime, signal.signalTimestamp, signal.generatedAt, structure.bos?.time, structure.choch?.time, liquidity.liquiditySweep?.time);
  const rangeHigh = firstNumber(signal.rangeHigh, signal.range?.high, structure.rangeHigh, structure.range?.high, v3.liquidity?.dealingRange?.high);
  const rangeLow = firstNumber(signal.rangeLow, signal.range?.low, structure.rangeLow, structure.range?.low, v3.liquidity?.dealingRange?.low);
  const event = firstText(liquidity.liquiditySweep?.sweptSource, liquidity.liquiditySweep?.subtype, structure.choch?.direction, structure.bos?.direction, 'none');
  return [accountId || 'default', signal.pair || signal.instrument || 'unknown', signal.direction || 'none', signal.session?.name || signal.session || 'none', rangeHigh ?? 'na', rangeLow ?? 'na', event, triggerTime || 'na'].join('|');
}
export function evaluateUniversalEntryPolicy(signal = {}) {
  const reasons = [];
  const status = timingStatus(signal);
  const direction = signal.direction;
  const sweepBlock = evaluateOpposingSweepBlock(signal, direction);
  if (!ALLOWED_TIMING.has(status)) reasons.push('entryTiming must be populated with a recognized terminal status');
  else if (status !== 'valid_entry') reasons.push(`entry timing ${status} is not executable`);
  if (pendingSweep(signal)) reasons.push('liquidity sweep is pending');
  if (!sweepBlock.allowed) reasons.push(sweepBlock.reason);
  if (rangeState(signal) && !confirmedBreakoutRetest(signal, direction)) reasons.push('range/consolidation requires a confirmed close outside the range and successful retest');
  return {
    allowed: reasons.length === 0,
    reasons,
    timingStatus: status || null,
    opposingSweep: sweepBlock.opposingSweep,
    reversalOverride: sweepBlock.reversalOverride,
    rangeDetected: rangeState(signal),
    breakoutRetestConfirmed: confirmedBreakoutRetest(signal, direction),
  };
}
""")

# ---------------------------------------------------------------------------
# Executor: Stage 2 is mandatory, direction is locked, ask/bid is authoritative,
# and all sizing geometry is recalculated from that executable side.
# ---------------------------------------------------------------------------
path = 'server/oandaTrade.js'
text = read(path)
text = replace_once(
    text,
    "import { evaluateV3FreshExecutionStage } from './v3QualityConfirmation.js';\n",
    '',
    'remove Stage 3 import',
)
text = replace_once(
    text,
    "import { reserveExecution, markExecutionOpen, releaseExecution } from './executionReservations.js';",
    "import { reserveExecution, markExecutionOpen, releaseExecution } from './executionReservations.js';\nimport { buildOandaMarketOrderPayload, repriceExecutableGeometry, validateDirectionLock } from './v3EntryContract.js';",
    'trade entry contract import',
)
text = replace_once(
    text,
    "  const pureV3Execution = isPureV3ExecutionSignal(signal);",
    "  const pureV3Execution = isPureV3ExecutionSignal(signal);\n  let executableEntry = Number(entry);\n  let executableGeometry = null;",
    'trade executable entry state',
)
text = replace_once(
    text,
    "  const universalPolicy = evaluateUniversalEntryPolicy(signal);\n  if (!universalPolicy.allowed) return blocked(`Universal entry policy: ${universalPolicy.reasons.join('; ')}`);",
    "  const universalPolicy = evaluateUniversalEntryPolicy(signal);\n  if (!universalPolicy.allowed) return blocked(`Universal entry policy: ${universalPolicy.reasons.join('; ')}`);\n\n  if (pureV3Execution) {\n    const stage2 = signal.qualityConfirmation?.stage2;\n    if (stage2?.allowed !== true) {\n      return blocked('Pure V3 execution requires a successful Stage 2 confirmation immediately before submission');\n    }\n    const directionLock = validateDirectionLock({\n      candidateDirection: direction,\n      confirmedDirection: signal.directionLock?.confirmedDirection || stage2.metrics?.lockedDirection,\n      freshDirection: signal.directionLock?.freshDirection || stage2.metrics?.direction,\n    });\n    if (!directionLock.allowed) return blocked(`Direction lock rejected: ${directionLock.reasons.join('; ')}`);\n  }",
    'trade Stage 2 and direction lock',
)
text = replace_once(
    text,
    "  // ── Guard 10: Dynamic risk sizing + pre-trade margin check ──────────────",
    "  if (pureV3Execution) {\n    let freshPricing;\n    try {\n      const pricingPayload = await getPricing([pair], { client });\n      freshPricing = Array.isArray(pricingPayload)\n        ? pricingPayload.find((row) => row?.instrument === pair || row?.pair === pair || row?.symbol === pair)\n        : pricingPayload?.[pair] || pricingPayload?.[String(pair).replace('_', '/')] || pricingPayload;\n    } catch (err) {\n      return blocked(`Executable quote fetch failed: ${err.message}`);\n    }\n\n    executableGeometry = repriceExecutableGeometry(signal, freshPricing || {}, {\n      minRR: MIN_EXECUTABLE_RR,\n      maxSpreadPips: maxSpread,\n      maxPriceDriftAtr: Number(process.env.V3_QUALITY_MAX_PRICE_DRIFT_ATR || 0.15),\n    });\n    executionLog.push(logEntry('V3_EXECUTABLE_GEOMETRY', executableGeometry));\n    if (!executableGeometry.allowed) {\n      return blocked(`Executable geometry rejected: ${executableGeometry.reasons.join('; ')}`);\n    }\n    executableEntry = executableGeometry.entry;\n    signal.entry = executableEntry;\n    signal.entryPrice = executableEntry;\n    signal.currentPrice = executableEntry;\n    signal.spreadPips = executableGeometry.spreadPips;\n  }\n\n  // ── Guard 10: Dynamic risk sizing + pre-trade margin check ──────────────",
    'trade executable quote geometry',
)
text = replace_once(
    text,
    "  if (signal.lifecycle?.sl && signal.lifecycle?.tp && signal.lifecycle.tp.allowed !== false) {",
    "  if (pureV3Execution && executableGeometry) {\n    slPips = executableGeometry.stopDistancePips;\n    slPriceFromLifecycle = executableGeometry.stopLoss;\n    tpPips = executableGeometry.targetDistancePips;\n    tpPriceFromLifecycle = executableGeometry.takeProfit;\n    console.log(`[TRADE] Repriced V3 geometry from ${executableGeometry.priceSide}: entry=${executableEntry} SL=${slPips.toFixed(1)}p TP=${tpPips.toFixed(1)}p RR=${executableGeometry.riskReward}`);\n  } else if (signal.lifecycle?.sl && signal.lifecycle?.tp && signal.lifecycle.tp.allowed !== false) {",
    'trade V3 lifecycle repricing',
)
text = text.replace('entryPrice: entry,', 'entryPrice: executableEntry,')
text = regex_once(
    text,
    r"\n  // Stage 3: fetch a fresh executable price immediately before submission\.[\s\S]*?\n  let units                 = sizing\.signedUnits;",
    "\n  let units                 = sizing.signedUnits;",
    'remove executor Stage 3 block',
)
text = replace_once(
    text,
    "  const orderPayload = {\n    order: {\n      type:               'MARKET',\n      instrument:         pair,\n      units:              units.toString(),\n      timeInForce:        'IOC',\n      positionFill:       'DEFAULT',\n      stopLossOnFill:     { price: slPrice.toFixed(priceDecimals), timeInForce: 'GTC' },\n      takeProfitOnFill:   { price: tpPrice.toFixed(priceDecimals), timeInForce: 'GTC' },\n    },\n  };",
    "  const orderPayload = buildOandaMarketOrderPayload({\n    pair,\n    signedUnits: units,\n    stopLoss: slPrice,\n    takeProfit: tpPrice,\n    priceDecimals,\n  });",
    'trade order payload helper',
)
text = text.replace('parseFloat(fillInfo.price || entry)', 'parseFloat(fillInfo.price || executableEntry)')
write(path, text)

# ---------------------------------------------------------------------------
# Tests and package scripts.
# ---------------------------------------------------------------------------
path = 'server/primaryTimeframeAlignment.test.js'
text = read(path)
text = regex_once(
    text,
    r"test\('2 of 3 aligned scores exactly 67 and passes with one opposing timeframe',[\s\S]*?\n\}\);\n",
    "test('Daily and H4 aligned score 67 and pass when M15 opposes', () => {\n  const result = evaluatePrimaryTimeframeAlignment({\n    timeframes: { daily: 'bullish', h4: 'bullish', m15: 'bearish' },\n  }, 'long');\n  assert.equal(result.passed, true);\n  assert.equal(result.score, 67);\n  assert.equal(result.dailyH4Aligned, true);\n  assert.deepEqual(result.alignedTimeframes.sort(), ['daily', 'h4']);\n});\n\ntest('Daily/H4 disagreement hard-rejects even when H4 and M15 align', () => {\n  const result = evaluatePrimaryTimeframeAlignment({\n    timeframes: { daily: 'bearish', h4: 'bullish', m15: 'bullish' },\n  }, 'long');\n  assert.equal(result.score, 67);\n  assert.equal(result.dailyH4Aligned, false);\n  assert.equal(result.passed, false);\n  assert.match(result.reason, /Daily and H4 must both align/);\n});\n",
    'primary tests hard Daily/H4',
)
write(path, text)

path = 'server/v3QualityConfirmation.test.js'
text = read(path)
text = text.replace("  evaluateV3TriggerStage,\n  evaluateV3FreshExecutionStage,", "  evaluateV3TriggerStage,")
text = replace_once(
    text,
    "    atrPips: 20,\n    qualityConfirmation:",
    "    atrPips: 20,\n    entryTiming: { status: 'valid_entry', retestDetected: true, retest: { direction: 'bullish', time: '2026-07-16T12:20:00.000Z' } },\n    qualityConfirmation:",
    'quality test timing',
)
text = replace_once(
    text,
    "      entryDistanceFromOriginPct: 0.42,\n      targets:",
    "      entryDistanceFromOriginPct: 0.42,\n      timeframes: { daily: 'bullish', h4: 'bullish', m15: 'bullish' },\n      targets:",
    'quality test timeframes',
)
text = text.replace("bos: { direction: 'bullish' }", "bos: { direction: 'bullish', time: '2026-07-16T12:10:00.000Z' }")
text = regex_once(
    text,
    r"\ntest\('Stage 3 accepts[\s\S]*\Z",
    "\n\ntest('Stage 2 blocks a confirmed opposing sweep', () => {\n  const signal = baseSignal();\n  signal.v3.liquidity = {\n    liquiditySweepDetected: true,\n    liquiditySweep: { subtype: 'confirmed_sweep', pending: false, direction: 'bearish', time: '2026-07-16T12:15:00.000Z' },\n  };\n  const result = evaluateV3TriggerStage(signal);\n  assert.equal(result.allowed, false);\n  assert.match(result.reasons.join(' '), /opposes long/);\n});\n",
    'remove Stage 3 tests',
)
write(path, text)

path = 'package.json'
text = read(path)
if 'server/v3EntryContract.integration.test.js' not in text:
    text = text.replace(
        'server/v3ExecutionModel.test.js server/v3ShadowLog.test.js',
        'server/v3ExecutionModel.test.js server/v3ShadowLog.test.js server/primaryTimeframeAlignment.test.js server/v3QualityConfirmation.test.js server/v3IndependentScanner.test.js server/v3EntryContract.integration.test.js',
    )
write(path, text)

print('V3 entry contract applied.')
