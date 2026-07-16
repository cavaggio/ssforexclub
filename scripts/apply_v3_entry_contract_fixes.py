#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path):
    return (ROOT / path).read_text(encoding='utf-8')


def write(path, text):
    (ROOT / path).write_text(text, encoding='utf-8')


path = 'server/v3EntryContract.js'
text = read(path)
old = """function eventTimestamp(event = {}) {
  const raw = event.time || event.timestamp || event.candleTime || event.detectedAt || null;
  const ms = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(ms) ? ms : null;
}
"""
new = """function eventTimestamp(event = {}) {
  if (!event || typeof event !== 'object') return null;
  const raw = event.time || event.timestamp || event.candleTime || event.detectedAt || null;
  const ms = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(ms) ? ms : null;
}
"""
if new not in text:
    if text.count(old) != 1:
        raise RuntimeError('eventTimestamp null guard anchor not found')
    text = text.replace(old, new, 1)
write(path, text)

write('server/executionPolicy.js', """import { ENTRY_TIMING_STATUSES, evaluateOpposingSweepBlock } from './v3EntryContract.js';

const ALLOWED_TIMING = new Set(ENTRY_TIMING_STATUSES);

function firstText(...values) {
  return values.find((value) => typeof value === 'string' && value.trim())?.trim() || '';
}
function firstNumber(...values) {
  for (const value of values) { const n = Number(value); if (Number.isFinite(n)) return n; }
  return null;
}
function extractV3(signal = {}) {
  return signal.v3 || signal.v3Eval || signal.v3Analysis || signal.metadata?.v3 || {};
}
function isV3ExecutionSignal(signal = {}) {
  const engine = firstText(
    signal.engine,
    signal.strategy,
    signal.selectedLogicType,
    signal.source,
    signal.architecture,
  ).toLowerCase();
  return Boolean(
    signal.v3 ||
    signal.v3Eval ||
    signal.v3Analysis ||
    signal.metadata?.v3 ||
    engine.includes('v3')
  );
}
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
  const v3Execution = isV3ExecutionSignal(signal);
  const sweepBlock = evaluateOpposingSweepBlock(signal, direction);

  if (v3Execution) {
    if (!ALLOWED_TIMING.has(status)) reasons.push('entryTiming must be populated with a recognized terminal status');
    else if (status !== 'valid_entry') reasons.push(`entry timing ${status} is not executable`);
  }
  if (pendingSweep(signal)) reasons.push('liquidity sweep is pending');
  if (!sweepBlock.allowed) reasons.push(sweepBlock.reason);
  if (v3Execution && rangeState(signal) && !confirmedBreakoutRetest(signal, direction)) {
    reasons.push('range/consolidation requires a confirmed close outside the range and successful retest');
  }
  return {
    allowed: reasons.length === 0,
    reasons,
    v3Execution,
    timingStatus: status || null,
    opposingSweep: sweepBlock.opposingSweep,
    reversalOverride: sweepBlock.reversalOverride,
    rangeDetected: rangeState(signal),
    breakoutRetestConfirmed: confirmedBreakoutRetest(signal, direction),
  };
}
""")

print('V3 entry contract follow-up fixes applied.')
