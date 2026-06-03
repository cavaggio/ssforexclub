import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreV3, V3_WEIGHTS, deriveDirection } from './v3ExecutionModel.js';

// ─── Fixtures shaped like the engine outputs ─────────────────────────────────

const earlyLong = {
  pair: 'EUR_USD',
  liquidity: {
    liquiditySweepDetected: true,
    liquiditySweep: { direction: 'bullish', reason: 'swept sell-side liquidity below recent low' },
    nearestLiquidityAbove: { label: 'Previous Day High', distancePips: 55, price: 1.1060 },
    nearestLiquidityBelow: { label: 'Asian Session Low', distancePips: 20, price: 1.0980 },
  },
  structure: { structureTrend: 'bullish', structureStrength: 75, bosDetected: true, bos: { direction: 'bullish' }, chochDetected: true, choch: { direction: 'bullish' } },
  session: { activeSession: 'London/NewYork Overlap', sessionQualityScore: 95, sessionBias: 'bullish' },
  volatility: { volatilityState: 'expanding', volatilityScore: 90, reasons: ['breaking out of compression'] },
  momentum: { momentumStrength: 60, executionSignal: 'long' },
  emaAlignment: 'aligned_bullish',
  targets: { accepted: true, tp1: { label: 'Equal Highs' }, tp3: { label: 'Previous Week High' }, remainingOpportunityPips: 30, expectedMovePotential: 100 },
};

// Late "confirmation" entry: EMA + momentum strongly bullish, but the move has
// already happened — no sweep, no fresh BOS/CHoCH, volatility already expanded.
const lateLong = {
  pair: 'EUR_USD',
  liquidity: { liquiditySweepDetected: false, liquiditySweep: null, nearestLiquidityAbove: { label: 'Previous Day High', distancePips: 8, price: 1.1010 }, nearestLiquidityBelow: { label: 'Asian Low', distancePips: 70, price: 1.0930 } },
  structure: { structureTrend: 'bullish', structureStrength: 80, bosDetected: false, bos: null, chochDetected: false, choch: null },
  session: { activeSession: 'London/NewYork Overlap', sessionQualityScore: 95, sessionBias: 'bullish' },
  volatility: { volatilityState: 'expanded', volatilityScore: 25, reasons: ['already travelled far'] },
  momentum: { momentumStrength: 85, executionSignal: 'long' },
  emaAlignment: 'aligned_bullish',
  targets: { accepted: true, tp1: { label: 'Previous Day High' }, tp3: { label: 'Previous Day High' }, remainingOpportunityPips: 8, expectedMovePotential: 8 },
};

test('V3: weights sum to 100 with correct priority order', () => {
  const sum = Object.values(V3_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.equal(sum, 100);
  assert.ok(V3_WEIGHTS.liquidity > V3_WEIGHTS.structure);
  assert.ok(V3_WEIGHTS.structure > V3_WEIGHTS.session);
  assert.ok(V3_WEIGHTS.session > V3_WEIGHTS.volatility);
  assert.ok(V3_WEIGHTS.volatility > V3_WEIGHTS.momentum);
  assert.ok(V3_WEIGHTS.momentum > V3_WEIGHTS.ema);
});

test('V3: EARLY setup (sweep + CHoCH + compression→expansion) qualifies high', () => {
  const r = scoreV3({ direction: 'long', ...earlyLong });
  assert.equal(r.direction, 'long');
  assert.equal(r.qualified, true, r.rejectionReasons.join('; '));
  assert.equal(r.earlyTrigger, true);
  assert.ok(r.score >= 70, `strong score (${r.score})`);
  // contributions sum to the score
  const sum = Math.round(Object.values(r.pillars).reduce((a, p) => a + p.contribution, 0));
  assert.equal(sum, r.score);
});

test('V3: LATE entry REJECTED even with bullish EMA + strong momentum', () => {
  const r = scoreV3({ direction: 'long', ...lateLong });
  assert.equal(r.qualified, false);
  assert.equal(r.earlyTrigger, false);
  assert.ok(
    r.rejectionReasons.some((x) => /early-entry trigger/i.test(x)),
    'rejects for lack of early trigger',
  );
});

test('V3: EMA is informational — opposing EMA still qualifies an early setup', () => {
  const r = scoreV3({ direction: 'long', ...earlyLong, emaAlignment: 'aligned_bearish' });
  assert.equal(r.qualified, true, r.rejectionReasons.join('; '));
  assert.equal(r.pillars.ema.weight, 5);
  assert.ok(r.pillars.ema.score01 <= 0.1, 'EMA pillar scored low but did not block');
});

test('V3: insufficient remaining opportunity rejects', () => {
  const r = scoreV3({ direction: 'long', ...earlyLong, targets: { accepted: false, rejectionReason: 'Insufficient remaining opportunity: nearest major liquidity 8p < 45p needed.' } });
  assert.equal(r.qualified, false);
  assert.ok(r.rejectionReasons.some((x) => /remaining opportunity/i.test(x)));
});

test('V3: counter-structure with no CHoCH rejects', () => {
  const r = scoreV3({
    direction: 'long',
    ...earlyLong,
    structure: { structureTrend: 'bearish', structureStrength: 70, bosDetected: false, chochDetected: false },
  });
  assert.equal(r.qualified, false);
  assert.ok(r.rejectionReasons.some((x) => /opposes/i.test(x)));
});

test('V3: derives its own direction from a fresh CHoCH when none forced', () => {
  const dir = deriveDirection({
    structure: { chochDetected: true, choch: { direction: 'bullish' }, structureTrend: 'bearish' },
  });
  assert.equal(dir, 'long');
  const r = scoreV3({ ...earlyLong, direction: null });
  assert.equal(r.direction, 'long');
});

test('V3: no directional basis yields a clean unqualified result', () => {
  const r = scoreV3({ pair: 'EUR_USD', structure: { structureTrend: 'ranging' } });
  assert.equal(r.direction, null);
  assert.equal(r.qualified, false);
  assert.equal(r.score, 0);
});
