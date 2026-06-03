/**
 * server/v3ExecutionModel.js
 *
 * Signal Stack V3 — re-weighted execution scoring model.
 *
 *   scoreV3({ pair, direction?, liquidity, structure, session, volatility,
 *             momentum, emaAlignment, targets })
 *
 * Shifts the engine from a confirmation/EMA/momentum model to a
 * liquidity + structure + volatility model. New priority order and weights:
 *
 *     Liquidity   28
 *     Structure   24
 *     Session     18
 *     Volatility  16
 *     Momentum     9
 *     EMA          5      (informational only)
 *                ----
 *                100
 *
 * Beyond the weighted score, qualification enforces the "enter earlier"
 * doctrine via two hard rules:
 *   1. There must be an EARLY-ENTRY TRIGGER (liquidity sweep, fresh BOS/CHoCH,
 *      or compression→expansion) — otherwise the entry is a late confirmation.
 *   2. There must be REMAINING OPPORTUNITY (targets.accepted) — no entering
 *      after a major level already caps the move.
 *
 * Returns a score, per-pillar breakdown, qualification decision, the chosen
 * direction, and a plain-language trade narrative. This module is PURE — it
 * decides nothing on its own; the scanner consumes it under a feature flag.
 */

export const V3_WEIGHTS = Object.freeze({
  liquidity: 28,
  structure: 24,
  session: 18,
  volatility: 16,
  momentum: 9,
  ema: 5,
});

const V3_MIN_SCORE = parseFloat(process.env.FOREX_V3_MIN_SCORE || '55');

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

function scoreLiquidity(direction, liquidity, targets) {
  const notes = [];
  if (!liquidity) return { s: 0.4, notes: ['No liquidity context.'] };
  const sign = dirSign(direction);
  let s = 0.4;
  const sweep = liquidity.liquiditySweep;
  if (liquidity.liquiditySweepDetected && sweep?.direction === sign) {
    s += 0.3; notes.push(`Liquidity sweep ${sweep.direction} aligns with ${direction}.`);
  } else if (liquidity.liquiditySweepDetected && sweep?.direction && sweep.direction !== sign) {
    s -= 0.15; notes.push(`Liquidity sweep ${sweep.direction} opposes ${direction}.`);
  }
  const target = direction === 'long' ? liquidity.nearestLiquidityAbove : liquidity.nearestLiquidityBelow;
  if (target) { s += 0.2; notes.push(`Draw toward ${target.label} (${target.distancePips}p).`); }
  if (targets) {
    if (targets.accepted) { s += 0.1; notes.push('Remaining opportunity sufficient.'); }
    else { s -= 0.35; notes.push('Liquidity caps the move — poor remaining opportunity.'); }
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

function scoreSession(direction, session) {
  const notes = [];
  if (!session) return { s: 0.4, notes: ['No session context.'] };
  let s = (session.sessionQualityScore ?? 40) / 100;
  if (session.sessionBias && session.sessionBias !== 'neutral') {
    const sign = dirSign(direction);
    if ((session.sessionBias === 'bullish') === (sign === 'bullish')) s = Math.min(1, s + 0.05);
    else s = Math.max(0, s - 0.05);
  }
  notes.push(`${session.activeSession} (quality ${session.sessionQualityScore}).`);
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
  structure = null,
  session = null,
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
    liquidity: scoreLiquidity(chosen, liquidity, targets),
    structure: scoreStructure(chosen, structure),
    session: scoreSession(chosen, session),
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
    volatility?.volatilityState === 'expanding' ||
    volatility?.volatilityState === 'compressed';

  // Qualification gates.
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
  for (const key of ['liquidity', 'structure', 'session', 'volatility']) {
    const n = pillars[key]?.notes?.[0];
    if (n) bits.push(n);
  }
  let tgt = '';
  if (targets?.tp1) {
    tgt = ` Targets: TP1 ${targets.tp1.label} (${targets.remainingOpportunityPips}p)` +
          (targets.tp3 ? `, TP3 ${targets.tp3.label} (${targets.expectedMovePotential}p).` : '.');
  }
  const head = `${qualified ? '✓' : '✗'} ${direction.toUpperCase()} ${pair} [V3]`;
  const trig = earlyTrigger ? '' : ' (no early trigger)';
  return `${head}${trig}: ${bits.join(' ')}${tgt}`;
}

export { V3_MIN_SCORE, deriveDirection };
