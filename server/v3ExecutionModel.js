/**
 * server/v3ExecutionModel.js
 *
 * Signal Stack V3.5 — liquidity-first execution scoring model.
 *
 *   scoreV3({ pair, direction?, liquidity, liquidityIntent, premiumDiscount,
 *             structure, session, sessionNarrative, volatility, momentum,
 *             emaAlignment, targets })
 *
 * V3.5 moves the engine from structure-first to LIQUIDITY-FIRST. The three
 * liquidity factors collectively dominate (50/100). New priority + weights:
 *
 *     Liquidity Intent    20   ← where stops rest / draw on liquidity (primary)
 *     Liquidity Sweep     17   ← pool-aware sweep + reclaim
 *     Liquidity Pools     13   ← draw toward nearest pool + remaining opportunity
 *     Structure           18   ← BOS / CHoCH / trend
 *     Session Narrative   12   ← "London swept Asian Low", "NY continuation"…
 *     Volatility          10
 *     Momentum             6
 *     EMA                  4   ← informational only; never gates
 *                        ----
 *                        100
 *
 * Premium/Discount is NOT a standalone weight. It is an entry-quality penalty
 * folded into the Liquidity-Intent pillar: buying premium / selling discount
 * haircuts the dominant pillar by up to 40%. It influences quality, never gates.
 *
 * Qualification still enforces the "enter earlier" doctrine via the same hard
 * rules as V3 (unchanged behaviour):
 *   1. An EARLY-ENTRY TRIGGER (liquidity sweep, fresh BOS/CHoCH, or
 *      compression→expansion) — otherwise the entry is a late confirmation.
 *   2. REMAINING OPPORTUNITY (targets.accepted) — no entering after a major
 *      level already caps the move.
 *
 * This module is PURE — it decides nothing on its own; the scanner consumes it
 * under FOREX_V3_ENGINE_MODE.
 */

export const V3_WEIGHTS = Object.freeze({
  liquidityIntent: 20,
  liquiditySweep: 17,
  liquidityPools: 13,
  structure: 18,
  sessionNarrative: 12,
  volatility: 10,
  momentum: 6,
  ema: 4,
});

const V3_MIN_SCORE = parseFloat(process.env.FOREX_V3_MIN_SCORE || '55');

// How hard premium/discount can haircut the liquidity-intent pillar (0..1).
const PD_PENALTY_WEIGHT = 0.4;

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const dirSign = (d) => (d === 'long' ? 'bullish' : d === 'short' ? 'bearish' : null);

// ─── Direction selection ─────────────────────────────────────────────────────
// When no direction is forced, derive a V3-native one: a fresh CHoCH (regime
// flip) leads, then prevailing structure, then a liquidity sweep's implied
// reversal, then session bias.
function deriveDirection({ structure, liquidity, session }) {
  if (structure?.chochDetected && structure.choch?.direction) {
    return structure.choch.direction === 'bullish' ? 'long' : 'short';
  }
  if (structure?.structureTrend === 'bullish') return 'long';
  if (structure?.structureTrend === 'bearish') return 'short';
  if (liquidity?.liquiditySweepDetected && liquidity.liquiditySweep?.direction) {
    return liquidity.liquiditySweep.direction === 'bullish' ? 'long' : 'short';
  }
  if (session?.sessionBias === 'bullish') return 'long';
  if (session?.sessionBias === 'bearish') return 'short';
  return null;
}

// ─── Pillar scorers (each → 0..1 with notes) ─────────────────────────────────

// Liquidity Intent — the primary factor. Base score is the stop-hunt engine's
// intentScore (does the trade target the heavier resting liquidity?). The
// premium/discount penalty folds in here: buying premium / selling discount
// haircuts the dominant pillar.
function scoreLiquidityIntent(direction, intent, premiumDiscount) {
  const notes = [];
  if (!intent) return { s: 0.4, notes: ['No liquidity-intent context.'] };
  let s = Number.isFinite(intent.intentScore) ? intent.intentScore : 0.45;
  notes.push(`Liquidity bias ${intent.liquidityBias}.`);
  if (intent.expectedLiquidityTarget) {
    notes.push(`Expected draw on liquidity: ${intent.expectedLiquidityTarget.label} (${intent.expectedLiquidityTarget.distancePips}p).`);
  }
  if (premiumDiscount && premiumDiscount.enabled) {
    const pen = premiumDiscount.entryQualityPenalty || 0;
    if (pen > 0) {
      s *= 1 - PD_PENALTY_WEIGHT * pen;
      notes.push(`${premiumDiscount.premiumDiscountState} entry — ${(pen * 100).toFixed(0)}% premium/discount penalty.`);
    } else {
      notes.push(`${premiumDiscount.premiumDiscountState} entry — favourable side.`);
    }
  }
  return { s: clamp01(s), notes };
}

// Liquidity Sweep — was a named pool's resting liquidity run and reclaimed in
// the trade direction? A strong aligned sweep is the best early trigger.
function scoreLiquiditySweep(direction, liquidity) {
  const sign = dirSign(direction);
  if (!liquidity || !liquidity.liquiditySweepDetected || !liquidity.liquiditySweep) {
    return { s: 0.35, notes: ['No liquidity sweep — entry lacks an early stop-run trigger.'] };
  }
  const sweep = liquidity.liquiditySweep;
  const strength = Number.isFinite(sweep.sweepStrength) ? sweep.sweepStrength : 0.5;
  if (sweep.direction === sign) {
    return {
      s: clamp01(0.55 + strength * 0.4),
      notes: [`${sweep.sweptLiquidity || 'Liquidity'} swept ${sweep.direction} — aligns with ${direction} (strength ${strength}).`],
    };
  }
  if (sweep.direction && sweep.direction !== sign) {
    return { s: 0.25, notes: [`${sweep.sweptLiquidity || 'Liquidity'} swept ${sweep.direction} — opposes ${direction}.`] };
  }
  return { s: 0.5, notes: ['Liquidity sweep detected (direction-neutral).'] };
}

// Liquidity Pools — is price being drawn toward a pool in the trade direction,
// and is there enough room before a major level caps the move?
function scoreLiquidityPools(direction, liquidity, targets) {
  const notes = [];
  if (!liquidity) return { s: 0.4, notes: ['No liquidity-pool context.'] };
  let s = 0.4;
  const target = direction === 'long' ? liquidity.nearestLiquidityAbove : liquidity.nearestLiquidityBelow;
  if (target) { s += 0.25; notes.push(`Draw toward ${target.label} (${target.distancePips}p).`); }
  if (targets) {
    if (targets.accepted) { s += 0.2; notes.push('Remaining opportunity sufficient.'); }
    else { s -= 0.3; notes.push('Liquidity caps the move — poor remaining opportunity.'); }
  }
  return { s: clamp01(s), notes };
}

function scoreStructure(direction, structure) {
  const notes = [];
  if (!structure) return { s: 0.4, notes: ['No structure context.'] };
  const sign = dirSign(direction);
  const aligned =
    (structure.structureTrend === 'bullish' && direction === 'long') ||
    (structure.structureTrend === 'bearish' && direction === 'short');
  let s = (structure.structureStrength ?? 40) / 100;
  if (aligned) {
    notes.push(`Structure ${structure.structureTrend} backs ${direction} (strength ${structure.structureStrength}).`);
  } else if (structure.chochDetected && structure.choch?.direction === sign) {
    s = Math.max(s, 0.7); notes.push(`Fresh ${sign} CHoCH — regime flipping toward ${direction}.`);
  } else if (structure.structureTrend !== 'ranging') {
    s *= 0.3; notes.push(`Structure ${structure.structureTrend} opposes ${direction} with no CHoCH.`);
  } else {
    s *= 0.7; notes.push('Ranging structure — no clear backing.');
  }
  if (structure.bosDetected && structure.bos?.direction === sign) {
    s = Math.min(1, s + 0.1); notes.push('BOS confirms direction.');
  }
  return { s: clamp01(s), notes };
}

// Session Narrative — the ICT trade story (sweep + session + structure) and how
// well its bias agrees with the trade.
function scoreSessionNarrative(direction, narrative, session) {
  const notes = [];
  if (!narrative) {
    if (!session) return { s: 0.4, notes: ['No session context.'] };
    notes.push(`${session.activeSession} (quality ${session.sessionQualityScore}).`);
    return { s: clamp01((session.sessionQualityScore ?? 40) / 100), notes };
  }
  let s = Number.isFinite(narrative.sessionConfidence)
    ? narrative.sessionConfidence
    : (session?.sessionQualityScore ?? 40) / 100;
  const sign = dirSign(direction);
  if (narrative.sessionBias && narrative.sessionBias !== 'neutral') {
    if ((narrative.sessionBias === 'bullish') === (sign === 'bullish')) s = Math.min(1, s + 0.05);
    else s = Math.max(0, s - 0.1);
  }
  notes.push(narrative.sessionNarrative);
  return { s: clamp01(s), notes };
}

function scoreVolatility(volatility) {
  if (!volatility) return { s: 0.5, notes: ['No volatility context.'] };
  return { s: clamp01((volatility.volatilityScore ?? 50) / 100), notes: [volatility.reasons?.[0] || volatility.volatilityState] };
}

function scoreMomentum(direction, momentum) {
  const notes = [];
  if (!momentum) return { s: 0.5, notes: ['No momentum context.'] };
  let s = (momentum.momentumStrength ?? 50) / 100;
  if (momentum.executionSignal && momentum.executionSignal !== direction) {
    s *= 0.4; notes.push(`Momentum (${momentum.executionSignal}) lags/opposes ${direction}.`);
  } else {
    notes.push(`Momentum strength ${momentum.momentumStrength ?? 'n/a'}.`);
  }
  return { s: clamp01(s), notes };
}

function scoreEma(direction, emaAlignment) {
  // Informational only — small weight. Aligned → 1, mixed → 0.4, opposed → 0.1.
  const a = String(emaAlignment || 'mixed').toLowerCase();
  const sign = dirSign(direction);
  if (a.includes(sign === 'bullish' ? 'bull' : 'bear')) return { s: 1, notes: ['EMA aligned (informational).'] };
  if (a === 'mixed') return { s: 0.4, notes: ['EMA mixed (informational).'] };
  return { s: 0.1, notes: ['EMA opposes (informational only — not gating).'] };
}

// ─── Main ────────────────────────────────────────────────────────────────────

export function scoreV3({
  pair,
  direction = null,
  liquidity = null,
  liquidityIntent = null,
  premiumDiscount = null,
  structure = null,
  session = null,
  sessionNarrative = null,
  volatility = null,
  momentum = null,
  emaAlignment = null,
  targets = null,
} = {}) {
  const chosen = direction || deriveDirection({ structure, liquidity, session });

  if (!chosen) {
    return {
      direction: null,
      score: 0,
      qualified: false,
      rejectionReasons: ['No directional basis (structure ranging, no sweep/CHoCH/session bias).'],
      pillars: {},
      earlyTrigger: false,
      narrative: `${pair}: no V3 directional basis.`,
      weights: V3_WEIGHTS,
    };
  }

  const p = {
    liquidityIntent: scoreLiquidityIntent(chosen, liquidityIntent, premiumDiscount),
    liquiditySweep: scoreLiquiditySweep(chosen, liquidity),
    liquidityPools: scoreLiquidityPools(chosen, liquidity, targets),
    structure: scoreStructure(chosen, structure),
    sessionNarrative: scoreSessionNarrative(chosen, sessionNarrative, session),
    volatility: scoreVolatility(volatility),
    momentum: scoreMomentum(chosen, momentum),
    ema: scoreEma(chosen, emaAlignment),
  };

  const pillars = {};
  let score = 0;
  for (const key of Object.keys(V3_WEIGHTS)) {
    const w = V3_WEIGHTS[key];
    const contribution = +(w * p[key].s).toFixed(2);
    score += contribution;
    pillars[key] = { score01: +p[key].s.toFixed(3), weight: w, contribution, notes: p[key].notes };
  }
  score = Math.round(score);

  // Early-entry trigger — the doctrine that we enter at the START of moves.
  const sign = dirSign(chosen);
  const earlyTrigger =
    (liquidity?.liquiditySweepDetected && liquidity.liquiditySweep?.direction === sign) ||
    (structure?.chochDetected && structure.choch?.direction === sign) ||
    (structure?.bosDetected && structure.bos?.direction === sign) ||
    volatility?.volatilityState === 'expanding';

  // Qualification gates (behaviour unchanged from V3).
  const rejectionReasons = [];
  if (targets && targets.accepted === false) {
    rejectionReasons.push(targets.rejectionReason || 'Insufficient remaining opportunity.');
  }
  if (!earlyTrigger) {
    rejectionReasons.push('No early-entry trigger (sweep / fresh BOS-CHoCH / compression-expansion) — would be a late confirmation entry.');
  }
  if (volatility?.volatilityState === 'expanded' && !(liquidity?.liquiditySweepDetected)) {
    rejectionReasons.push('Volatility already extended with no fresh liquidity trigger — chasing a late move.');
  }
  const structureOpposes =
    structure && structure.structureTrend !== 'ranging' &&
    structure.structureTrend !== sign &&
    !(structure.chochDetected && structure.choch?.direction === sign);
  if (structureOpposes) {
    rejectionReasons.push(`Structure (${structure.structureTrend}) opposes ${chosen} with no CHoCH flip.`);
  }
  if (score < V3_MIN_SCORE) {
    rejectionReasons.push(`V3 score ${score} < min ${V3_MIN_SCORE}.`);
  }

  const qualified = rejectionReasons.length === 0;
  const narrative = buildNarrative({ pair, direction: chosen, pillars, targets, earlyTrigger, qualified });

  return {
    direction: chosen,
    score,
    qualified,
    rejectionReasons,
    pillars,
    earlyTrigger,
    narrative,
    weights: V3_WEIGHTS,
  };
}

function buildNarrative({ pair, direction, pillars, targets, earlyTrigger, qualified }) {
  const bits = [];
  for (const key of ['liquidityIntent', 'liquiditySweep', 'structure', 'sessionNarrative']) {
    const n = pillars[key]?.notes?.[0];
    if (n) bits.push(n);
  }
  let tgt = '';
  if (targets?.tp1) {
    tgt = ` Targets: TP1 ${targets.tp1.label} (${targets.remainingOpportunityPips}p)` +
          (targets.tp3 ? `, TP3 ${targets.tp3.label} (${targets.expectedMovePotential}p).` : '.');
  }
  const head = `${qualified ? '✓' : '✗'} ${direction.toUpperCase()} ${pair} [V3.5]`;
  const trig = earlyTrigger ? '' : ' (no early trigger)';
  return `${head}${trig}: ${bits.join(' ')}${tgt}`;
}

export { V3_MIN_SCORE, deriveDirection };
