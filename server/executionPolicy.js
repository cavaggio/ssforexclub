const BLOCKED_TIMING = new Set(['too_early','late_entry','wait_for_retest','pending_sweep','pending','early','late']);

function directionSign(direction) {
  const d = String(direction || '').toLowerCase();
  return d === 'long' || d === 'buy' ? 'bullish' : d === 'short' || d === 'sell' ? 'bearish' : null;
}
function firstText(...values) {
  return values.find((v) => typeof v === 'string' && v.trim())?.trim() || '';
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
  return sweep.pending === true || String(sweep.subtype || '').toLowerCase() === 'pending_sweep' || timingStatus(signal) === 'pending_sweep';
}
function opposingFlow(signal = {}, direction) {
  const sign = directionSign(direction); const flow = signal.institutionalFlow || extractV3(signal).institutionalFlow || {};
  const dir = String(flow.direction || '').toLowerCase();
  return flow.detected === true && dir && dir !== 'neutral' && dir !== sign;
}
function rangeState(signal = {}) {
  const v3 = extractV3(signal); const s = v3.structure || signal.structure || {}; const r = v3.marketRegime || signal.marketRegime || {};
  const state = firstText(signal.marketState, signal.regime, r.regime, r.state, s.marketState, s.structureTrend).toLowerCase();
  return state.includes('rang') || state.includes('consolidat') || state.includes('choppy') || state.includes('whipsaw');
}
function confirmedBreakoutRetest(signal = {}, direction) {
  const v3 = extractV3(signal); const s = v3.structure || signal.structure || {}; const t = signal.entryTiming || {};
  const sign = directionSign(direction);
  const breakDirection = firstText(signal.rangeBreakout?.direction, s.breakoutDirection, s.bos?.direction, s.choch?.direction).toLowerCase();
  const closeOutside = signal.rangeBreakout?.closeOutside === true || s.closeOutsideRange === true || s.rangeBreakConfirmed === true;
  const retest = t.retestDetected === true && String(t.status || '').toLowerCase() === 'valid_entry';
  return closeOutside && retest && (!breakDirection || breakDirection === sign);
}
export function setupFingerprint(signal = {}, accountId = '') {
  const v3 = extractV3(signal); const s = v3.structure || signal.structure || {}; const l = v3.liquidity || signal.liquidity || {};
  const triggerTime = firstText(signal.triggerCandleTime, signal.signalTimestamp, signal.generatedAt, s.bos?.time, s.choch?.time, l.liquiditySweep?.time);
  const rangeHigh = firstNumber(signal.rangeHigh, signal.range?.high, s.rangeHigh, s.range?.high, v3.liquidity?.dealingRange?.high);
  const rangeLow = firstNumber(signal.rangeLow, signal.range?.low, s.rangeLow, s.range?.low, v3.liquidity?.dealingRange?.low);
  const event = firstText(l.liquiditySweep?.poolSource, l.liquiditySweep?.subtype, s.choch?.direction, s.bos?.direction, 'none');
  return [accountId || 'default', signal.pair || signal.instrument || 'unknown', signal.direction || 'none', signal.session?.name || signal.session || 'none', rangeHigh ?? 'na', rangeLow ?? 'na', event, triggerTime || 'na'].join('|');
}
export function evaluateUniversalEntryPolicy(signal = {}) {
  const reasons = []; const status = timingStatus(signal); const direction = signal.direction;
  if (BLOCKED_TIMING.has(status)) reasons.push(`entry timing ${status} is not executable`);
  if (pendingSweep(signal)) reasons.push('liquidity sweep is pending');
  if (opposingFlow(signal, direction)) reasons.push('institutional flow opposes the proposed direction');
  if (rangeState(signal) && !confirmedBreakoutRetest(signal, direction)) reasons.push('range/consolidation requires a confirmed close outside the range and successful retest');
  return { allowed: reasons.length === 0, reasons, timingStatus: status || null, rangeDetected: rangeState(signal), breakoutRetestConfirmed: confirmedBreakoutRetest(signal, direction) };
}
