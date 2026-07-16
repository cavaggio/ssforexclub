#!/usr/bin/env python3
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]

def p(path): return ROOT / path
def read(path): return p(path).read_text(encoding='utf-8')
def write(path, text):
    p(path).parent.mkdir(parents=True, exist_ok=True)
    p(path).write_text(text, encoding='utf-8')
def once(text, old, new, label):
    n = text.count(old)
    if n == 0 and new in text: return text
    if n != 1: raise RuntimeError(f'{label}: expected 1 match, found {n}')
    return text.replace(old, new, 1)
def sub_once(text, pattern, repl, label, flags=0):
    out, n = re.subn(pattern, repl, text, count=1, flags=flags)
    if n == 0 and re.search(re.escape(repl[:40]), text): return text
    if n != 1: raise RuntimeError(f'{label}: expected 1 match, found {n}')
    return out

# Shared universal entry policy.
write('server/executionPolicy.js', r'''const BLOCKED_TIMING = new Set(['too_early','late_entry','wait_for_retest','pending_sweep','pending','early','late']);

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
''')

# Optional persistent atomic reservation store. Supabase is authoritative when configured.
write('server/executionReservations.js', r'''import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const memory = new Map(); let client;
function db() {
  if (client !== undefined) return client;
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  client = url && key ? createClient(url, key, { auth: { persistSession:false, autoRefreshToken:false } }) : null;
  return client;
}
export function fingerprintHash(fingerprint) { return createHash('sha256').update(String(fingerprint)).digest('hex'); }
export async function reserveExecution({ fingerprint, accountId, pair, direction, expiresMinutes = 30 }) {
  const hash = fingerprintHash(fingerprint); const now = new Date(); const expiresAt = new Date(now.getTime() + expiresMinutes * 60000).toISOString();
  const local = memory.get(hash);
  if (local && local.expiresAt > now.getTime() && ['reserved','open','loss_locked'].includes(local.status)) return { allowed:false, reason:`setup already ${local.status}`, hash };
  const supabase = db();
  if (supabase) {
    const { data: existing } = await supabase.from('execution_reservations').select('status,expires_at,locked_until').eq('fingerprint_hash', hash).maybeSingle();
    if (existing) {
      const locked = existing.status === 'loss_locked' && (!existing.locked_until || new Date(existing.locked_until) > now);
      const active = ['reserved','open'].includes(existing.status) && new Date(existing.expires_at) > now;
      if (locked || active) return { allowed:false, reason:`setup already ${existing.status}`, hash };
    }
    const { error } = await supabase.from('execution_reservations').upsert({ fingerprint_hash:hash, fingerprint, account_id:String(accountId||''), pair, direction, status:'reserved', expires_at:expiresAt, updated_at:now.toISOString() }, { onConflict:'fingerprint_hash' });
    if (error) return { allowed:false, reason:`reservation store error: ${error.message}`, hash };
  }
  memory.set(hash, { status:'reserved', expiresAt:new Date(expiresAt).getTime() });
  return { allowed:true, hash };
}
export async function markExecutionOpen({ hash, tradeId }) {
  const row = memory.get(hash) || {}; memory.set(hash, { ...row, status:'open', tradeId });
  const supabase = db(); if (supabase) await supabase.from('execution_reservations').update({ status:'open', trade_id:String(tradeId||''), updated_at:new Date().toISOString() }).eq('fingerprint_hash', hash);
}
export async function releaseExecution(hash, status='released') {
  const row = memory.get(hash) || {}; memory.set(hash, { ...row, status, expiresAt:0 });
  const supabase = db(); if (supabase) await supabase.from('execution_reservations').update({ status, updated_at:new Date().toISOString() }).eq('fingerprint_hash', hash);
}
export async function lockTradeAfterLoss(tradeId, hours = 24) {
  const supabase = db(); if (!supabase || !tradeId) return;
  const lockedUntil = new Date(Date.now() + hours * 3600000).toISOString();
  await supabase.from('execution_reservations').update({ status:'loss_locked', locked_until:lockedUntil, updated_at:new Date().toISOString() }).eq('trade_id', String(tradeId));
}
''')

write('supabase/migrations/20260716090000_execution_reservations.sql', r'''create table if not exists public.execution_reservations (
  fingerprint_hash text primary key,
  fingerprint text not null,
  account_id text not null,
  pair text not null,
  direction text not null,
  status text not null check (status in ('reserved','open','released','cancelled','failed','loss_locked','closed')),
  trade_id text,
  expires_at timestamptz not null,
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists execution_reservations_trade_id_idx on public.execution_reservations(trade_id) where trade_id is not null;
alter table public.execution_reservations enable row level security;
''')

# Central risk manager.
risk = read('server/riskManager.js')
risk = risk.replace('(1.4%).', '(1.25%).').replace('(2.8%) of the day', '(2.5%) of the day')
risk = risk.replace("maxRiskPerTradePercent: parseFloat(process.env.RISK_MAX_PER_TRADE_PERCENT || '1.4')", "maxRiskPerTradePercent: parseFloat(process.env.RISK_MAX_PER_TRADE_PERCENT || '1.25')")
risk = risk.replace("dailyMaxDrawdownPercent: parseFloat(process.env.RISK_DAILY_MAX_DRAWDOWN_PERCENT || '2.8')", "dailyMaxDrawdownPercent: 2.5")
if 'reserveDailyLossBudget' not in risk:
    anchor = '/** Manual/admin reset of all daily baselines (e.g. broker daily reset hook). */'
    fn = r'''/** Size a new order to the uncommitted remainder of the fixed 2.5% daily budget. */
export function reserveDailyLossBudget({ accountId, balanceUSD, openRiskUSD = 0, requestedRiskUSD = 0, now = new Date() } = {}) {
  const lock = checkDailyRiskLock({ accountId, balanceUSD, now });
  const openRisk = Math.max(0, Number(openRiskUSD) || 0);
  const requested = Math.max(0, Number(requestedRiskUSD) || 0);
  const remainingAfterOpenRisk = Math.max(0, lock.remainingLossBudget - openRisk);
  const approvedRiskUSD = Math.floor(Math.min(requested, remainingAfterOpenRisk) * 100) / 100;
  return {
    allowed: !lock.tradingLocked && approvedRiskUSD > 0,
    capped: approvedRiskUSD + 0.005 < requested,
    approvedRiskUSD,
    requestedRiskUSD: requested,
    openRiskUSD: openRisk,
    remainingDailyBudgetUSD: lock.remainingLossBudget,
    remainingAfterOpenRiskUSD: remainingAfterOpenRisk,
    reason: lock.tradingLocked ? lock.reason : approvedRiskUSD <= 0 ? 'No uncommitted daily loss budget remains.' : null,
  };
}

'''
    risk = once(risk, anchor, fn + anchor, 'risk reservation insertion')
write('server/riskManager.js', risk)

sizing = read('server/oandaRiskSizing.js').replace("process.env.FOREX_MAX_RISK_PERCENT || '1.4'", "process.env.FOREX_MAX_RISK_PERCENT || '1.25'")
write('server/oandaRiskSizing.js', sizing)

decision = read('server/tradeDecisionEngine.js').replace('maxDailyLossPercent: 2.8', 'maxDailyLossPercent: 2.5')
write('server/tradeDecisionEngine.js', decision)

# V3 stage 1: TP confidence remains diagnostic, never an initial entry confirmation.
v3q = read('server/v3QualityConfirmation.js')
v3q = re.sub(r"\n\s*const minTpHitConfidence = Math\.max\(85, envNumber\([\s\S]*?\);\n", "\n", v3q, count=1)
v3q = re.sub(r"\n\s*if \(tpHitConfidence < minTpHitConfidence\) reasons\.push\([^\n]+\);", "", v3q, count=1)
v3q = v3q.replace('minConfidence: minTpHitConfidence,\n      minTpHitConfidence,', "minConfidence: null,\n      minTpHitConfidence: null,\n      tpConfidencePolicy: 'diagnostic_only',")
write('server/v3QualityConfirmation.js', v3q)

# V3 candidate keeps entry quality as confidence; TP confidence is diagnostic only.
scanner = read('server/v3IndependentScanner.js')
scanner = scanner.replace('candidate.confidence = tpHitConfidence;', "candidate.confidence = entryQualityConfidence;\n  candidate.tpConfidencePolicy = 'diagnostic_only';")
write('server/v3IndependentScanner.js', scanner)

# OANDA execution integration.
ot = read('server/oandaTrade.js')
ot = ot.replace("import { checkTotalOpenRisk, computeOpenRiskPercent } from './autoAiRiskLimits.js';", "import { checkTotalOpenRisk, computeOpenRiskPercent, computeOpenRiskUSD } from './autoAiRiskLimits.js';")
ot = ot.replace('  checkDailyRiskLock,\n  checkAutoExecutionConfidence,', '  checkDailyRiskLock,\n  reserveDailyLossBudget,\n  checkAutoExecutionConfidence,')
ot = ot.replace("import { HARD_SCALP_CONFIDENCE_FLOOR", "import { evaluateUniversalEntryPolicy, setupFingerprint } from './executionPolicy.js';\nimport { reserveExecution, markExecutionOpen, releaseExecution } from './executionReservations.js';\n\nimport { HARD_SCALP_CONFIDENCE_FLOOR")
ot = ot.replace("const MAX_DAILY_LOSS_PERCENT= parseFloat(process.env.FOREX_MAX_DAILY_LOSS_PERCENT || '2');\n", '')
ot = ot.replace("const confidence = pureV3Execution ? tpHitConfidence : Number(signalConfidence);", "const confidence = Number(entryQualityConfidence); // TP confidence is diagnostic only")
ot = ot.replace('    signal.tpProbability = +(tpHitConfidence / 100).toFixed(3);\n    signal.slProbability = +(1 - signal.tpProbability).toFixed(3);\n    // Generic confidence remains a compatibility alias only.\n    signal.confidence = tpHitConfidence;', "    signal.tpProbability = +(tpHitConfidence / 100).toFixed(3);\n    signal.slProbability = +(1 - signal.tpProbability).toFixed(3);\n    signal.tpConfidencePolicy = 'diagnostic_only';\n    signal.confidence = entryQualityConfidence;")
# Replace initial TP-confidence gate with entry-quality confidence gate.
ot = re.sub(r"\n\s*const configuredV3TpFloor[\s\S]*?if \(isExplicitSwingSignal\(signal\)\)", "\n  const executionConfidenceFloor = MIN_CONFIDENCE;\n  if (!Number.isFinite(confidence) || confidence < executionConfidenceFloor) {\n    return blocked(`Entry-quality confidence ${Number.isFinite(confidence) ? confidence : 'n/a'}% < minimum ${executionConfidenceFloor}%`);\n  }\n  if (isExplicitSwingSignal(signal))", ot, count=1)
# Universal timing/range/flow block before SL/TP.
anchor = '  // ── Guard 4: SL and TP present'
block = "  const universalPolicy = evaluateUniversalEntryPolicy(signal);\n  if (!universalPolicy.allowed) return blocked(`Universal entry policy: ${universalPolicy.reasons.join('; ')}`);\n\n"
ot = once(ot, anchor, block + anchor, 'oanda universal policy')
# Remove duplicate legacy daily counter block.
ot = re.sub(r"\n\s*if \(dailyStartBalance === null\)[\s\S]*?\n\s*}\n\n\s*// ── Guard 10", "\n\n  // ── Guard 10", ot, count=1)
# Daily projected reservation after dynamic risk cap.
anchor = "  // Use the signal's lifecycle SL/TP if present and fresh; otherwise recompute."
reservation = r'''  let openTradesForBudget = [];
  try { openTradesForBudget = (await getOpenTrades({ client })) || []; }
  catch (err) { return blocked(`Could not calculate open stop risk: ${err.message}`); }
  const dailyBudget = reserveDailyLossBudget({
    accountId: client?.accountId,
    balanceUSD,
    openRiskUSD: computeOpenRiskUSD(openTradesForBudget),
    requestedRiskUSD: dynamicRisk.riskUSD,
  });
  if (!dailyBudget.allowed) return blocked(dailyBudget.reason);
  if (dailyBudget.capped) {
    dynamicRisk.riskUSD = dailyBudget.approvedRiskUSD;
    dynamicRisk.riskPercent = +((dailyBudget.approvedRiskUSD / balanceUSD) * 100).toFixed(4);
  }

'''
ot = once(ot, anchor, reservation + anchor, 'oanda daily reservation')
# Atomic setup reservation before broker call.
anchor = '  const orderPayload = {'
atomic = r'''  const setupKey = setupFingerprint(signal, accountId);
  const executionReservation = await reserveExecution({ fingerprint: setupKey, accountId, pair, direction });
  if (!executionReservation.allowed) return blocked(`Atomic setup reservation rejected: ${executionReservation.reason}`);
  const executionReservationHash = executionReservation.hash;

'''
ot = once(ot, anchor, atomic + anchor, 'oanda atomic reservation')
ot = ot.replace('    return {\n      success:        false,\n      blocked:        false,\n      executionState: \'REJECTED\',\n      reason:         `Order submission failed: ${err.message}`', "    await releaseExecution(executionReservationHash, 'failed');\n    return {\n      success:        false,\n      blocked:        false,\n      executionState: 'REJECTED',\n      reason:         `Order submission failed: ${err.message}`")
ot = ot.replace("    return {\n      success:        false,\n      blocked:        false,\n      executionState: 'CANCELLED',", "    await releaseExecution(executionReservationHash, 'cancelled');\n    return {\n      success:        false,\n      blocked:        false,\n      executionState: 'CANCELLED',")
ot = ot.replace('  const tradeId         = fillInfo.tradeId;', '  const tradeId         = fillInfo.tradeId;\n  await markExecutionOpen({ hash: executionReservationHash, tradeId });')
# Remove TP-confidence post-fill liquidation logic; keep R:R revalidation.
ot = re.sub(r"\n\s*// Reprice V3 TP-hit confidence using actual broker geometry\.[\s\S]*?\n\s*if \(pureV3Execution\) \{\n\s*signal\.preFillTpHitConfidence", "\n  const postFillTpHitConfidence = pureV3Execution ? repriceV3TpHitConfidence({ baseConfidence: tpHitConfidence, originalRR: finalSizingRR, actualRR: actualFillRR }) : null;\n  if (pureV3Execution) {\n    signal.preFillTpHitConfidence", ot, count=1)
write('server/oandaTrade.js', ot)

# ICT uses the same universal policy and risk reservation; remove fabricated June-23 confirmations.
ict = read('server/ictExecution.js')
ict = ict.replace("import { checkTotalOpenRisk, computeOpenRiskPercent } from './autoAiRiskLimits.js';", "import { checkTotalOpenRisk, computeOpenRiskPercent, computeOpenRiskUSD } from './autoAiRiskLimits.js';")
ict = ict.replace('  checkDailyRiskLock,\n  checkAutoExecutionConfidence,', '  checkDailyRiskLock,\n  reserveDailyLossBudget,\n  checkAutoExecutionConfidence,')
ict = ict.replace("import { isExplicitSwingSignal }", "import { evaluateUniversalEntryPolicy, setupFingerprint } from './executionPolicy.js';\nimport { reserveExecution, markExecutionOpen, releaseExecution } from './executionReservations.js';\nimport { isExplicitSwingSignal }")
anchor = '  // ── 4b. ForexFactory news risk'
block = "  const universalPolicy = evaluateUniversalEntryPolicy({ ...analysis, pair, direction });\n  if (!universalPolicy.allowed) return blocked(`Universal entry policy: ${universalPolicy.reasons.join('; ')}`);\n\n"
ict = once(ict, anchor, block + anchor, 'ict universal policy')
old = '  const effectiveRiskPercent = capPerTradeRiskPercent(config.maxRiskPercent);\n  const targetRiskUSD = +(balanceUSD * (effectiveRiskPercent / 100)).toFixed(2);'
new = "  const effectiveRiskPercent = capPerTradeRiskPercent(config.maxRiskPercent);\n  const requestedRiskUSD = +(balanceUSD * (effectiveRiskPercent / 100)).toFixed(2);\n  let openTradesForBudget = [];\n  try { const openFn = getOpen || (() => getOpenTrades({ client })); openTradesForBudget = (await openFn()) || []; } catch (err) { return blocked(`Could not calculate open stop risk: ${err.message}`); }\n  const dailyBudget = reserveDailyLossBudget({ accountId: client.accountId, balanceUSD, openRiskUSD: computeOpenRiskUSD(openTradesForBudget), requestedRiskUSD, now });\n  if (!dailyBudget.allowed) return blocked(dailyBudget.reason);\n  const targetRiskUSD = dailyBudget.approvedRiskUSD;"
ict = once(ict, old, new, 'ict daily reservation')
# Delete fabricated centralized gate and replace with atomic reservation.
ict = re.sub(r"\n\s*const signal = analysis[\s\S]*?\n\s*resp = await client\.post", "\n    const executionSignal = { ...analysis, pair, direction, entry, stopLoss, takeProfit: targetProfit };\n    const setupKey = setupFingerprint(executionSignal, accountId);\n    const reservation = await reserveExecution({ fingerprint: setupKey, accountId, pair, direction });\n    if (!reservation.allowed) return blocked(`Atomic setup reservation rejected: ${reservation.reason}`);\n    params.__reservationHash = reservation.hash;\n    resp = await client.post", ict, count=1)
ict = ict.replace("    rec(`rejected: submit error ${err.message}`);", "    if (params.__reservationHash) await releaseExecution(params.__reservationHash, 'failed');\n    rec(`rejected: submit error ${err.message}`);")
ict = ict.replace("    rec(`rejected: cancelled by OANDA (${reason})`);", "    if (params.__reservationHash) await releaseExecution(params.__reservationHash, 'cancelled');\n    rec(`rejected: cancelled by OANDA (${reason})`);")
ict = ict.replace('  const tradeId = fill.tradeOpened?.tradeID || fill.id || fill.tradeID || null;', '  const tradeId = fill.tradeOpened?.tradeID || fill.id || fill.tradeID || null;\n  if (params.__reservationHash) await markExecutionOpen({ hash: params.__reservationHash, tradeId });')
write('server/ictExecution.js', ict)

# Transaction sync marks a fingerprint as loss-locked when OANDA reports an SL.
tx_path = 'web/lib/oandaTransactionSync.ts'
if p(tx_path).exists():
    tx = read(tx_path)
    if 'execution_reservations' not in tx:
        needle = "        if (result.ok) logged += 1;\n        else failed += 1;"
        repl = "        if (result.ok) logged += 1;\n        else failed += 1;\n\n        if (result.ok && closeReason === 'SL_HIT' && event.tradeId) {\n          const supabase = getServerSupabase();\n          const lockedUntil = new Date(Date.now() + Number(process.env.POST_LOSS_REENTRY_LOCK_HOURS || 24) * 3600000).toISOString();\n          await supabase.from('execution_reservations').update({ status: 'loss_locked', locked_until: lockedUntil, updated_at: new Date().toISOString() }).eq('trade_id', String(event.tradeId));\n        }"
        tx = once(tx, needle, repl, 'transaction loss lock')
    write(tx_path, tx)

# Tests/default expectations.
t = read('server/riskManager.test.js')
t = t.replace('1.4% / 2.8%', '1.25% / 2.5%').replace('1.4% per trade, 2.8% daily', '1.25% per trade, 2.5% daily')
t = t.replace('cfg.maxRiskPerTradePercent, 1.4', 'cfg.maxRiskPerTradePercent, 1.25').replace('cfg.dailyMaxDrawdownPercent, 2.8', 'cfg.dailyMaxDrawdownPercent, 2.5')
t = t.replace('computeRiskBudgetUSD(10000), 140', 'computeRiskBudgetUSD(10000), 125').replace('capPerTradeRiskPercent(2.0), 1.4', 'capPerTradeRiskPercent(2.0), 1.25')
t = t.replace('actualDollarRisk: 140', 'actualDollarRisk: 125').replace('hard cap 1\\.4%', 'hard cap 1\\.25%')
t = t.replace('riskPerTradePercent, 1.4', 'riskPerTradePercent, 1.25').replace('riskAmountUSD, 140', 'riskAmountUSD, 125')
t = t.replace('dailyLossLimitPercent, 2.8', 'dailyLossLimitPercent, 2.5').replace('dailyLossLimitUSD, 280', 'dailyLossLimitUSD, 250')
write('server/riskManager.test.js', t)

print('Production execution hardening applied.')
