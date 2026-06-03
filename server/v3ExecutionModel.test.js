import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreV3, V3_WEIGHTS, deriveDirection } from './v3ExecutionModel.js';

// ─── Fixtures shaped like the V3.5 engine outputs ────────────────────────────

const earlyLong = {
  pair: 'EUR_USD',
  liquidity: {
    liquiditySweepDetected: true,
    liquiditySweep: { direction: 'bullish', sweptLiquidity: 'Asian Session Low', sweptSource: 'ASIA_L', sweepStrength: 0.8, reason: 'swept sell-side liquidity below Asian low' },
    nearestLiquidityAbove: { label: 'Previous Day High', distancePips: 55, price: 1.1060 },
    nearestLiquidityBelow: { label: 'Asian Session Low', distancePips: 20, price: 1.0980 },
  },
  liquidityIntent: {
    intentScore: 0.85,
    liquidityBias: 'bullish',
    expectedLiquidityTarget: { label: 'Previous Day High', distancePips: 55 },
    likelyStopsAbove: [{ label: 'Previous Day High', source: 'PDH' }],
    likelyStopsBelow: [],
  },
  premiumDiscount: { enabled: true, premiumDiscountState: 'discount', premiumDiscountScore: 1, entryQualityPenalty: 0, reason: 'discount entry' },
  structure: { structureTrend: 'bullish', structureStrength: 75, bosDetected: true, bos: { direction: 'bullish' }, chochDetected: true, choch: { direction: 'bullish' } },
  session: { activeSession: 'London/NewYork Overlap', sessionQualityScore: 95, sessionBias: 'bullish' },
  sessionNarrative: { sessionNarrative: 'London swept Asian Low', sessionBias: 'bullish', sessionConfidence: 0.9 },
  volatility: { volatilityState: 'expanding', volatilityScore: 90, reasons: ['breaking out of compression'] },
  momentum: { momentumStrength: 60, executionSignal: 'long' },
  emaAlignment: 'aligned_bullish',
  targets: { accepted: true, tp1: { label: 'Equal Highs' }, tp3: { label: 'Previous Week High' }, remainingOpportunityPips: 30, expectedMovePotential: 100 },
};

// Late "confirmation" entry: EMA + momentum strongly bullish, but the move has
// already happened — no sweep, no fresh BOS/CHoCH, volatility already expanded,
// and price is in premium (P/D penalty bites the dominant pillar).
const lateLong = {
  pair: 'EUR_USD',
  liquidity: { liquiditySweepDetected: false, liquiditySweep: null, nearestLiquidityAbove: { label: 'Previous Day High', distancePips: 8, price: 1.1010 }, nearestLiquidityBelow: { label: 'Asian Low', distancePips: 70, price: 1.0930 } },
  liquidityIntent: { intentScore: 0.4, liquidityBias: 'bullish', expectedLiquidityTarget: { label: 'Previous Day High', distancePips: 8 }, likelyStopsAbove: [{ label: 'Previous Day High', source: 'PDH' }], likelyStopsBelow: [] },
  premiumDiscount: { enabled: true, premiumDiscountState: 'premium', premiumDiscountScore: 0.2, entryQualityPenalty: 0.8, reason: 'premium entry — 80% penalty' },
  structure: { structureTrend: 'bullish', structureStrength: 80, bosDetected: false, bos: null, chochDetected: false, choch: null },
  session: { activeSession: 'London/NewYork Overlap', sessionQualityScore: 95, sessionBias: 'bullish' },
  sessionNarrative: { sessionNarrative: 'NewYork — bullish bias', sessionBias: 'bullish', sessionConfidence: 0.7 },
  volatility: { volatilityState: 'expanded', volatilityScore: 25, reasons: ['already travelled far'] },
  momentum: { momentumStrength: 85, executionSignal: 'long' },
  emaAlignment: 'aligned_bullish',
  targets: { accepted: true, tp1: { label: 'Previous Day High' }, tp3: { label: 'Previous Day High' }, remainingOpportunityPips: 8, expectedMovePotential: 8 },
};

test('V3.5: weights sum to 100 with liquidity-first priority', () => {
  const sum = Object.values(V3_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.equal(sum, 100);
  const liquidity = V3_WEIGHTS.liquidityIntent + V3_WEIGHTS.liquiditySweep + V3_WEIGHTS.liquidityPools;
  assert.equal(liquidity, 50, 'three liquidity factors dominate at 50/100');
  assert.ok(V3_WEIGHTS.liquidityIntent > V3_WEIGHTS.liquiditySweep);
  assert.ok(V3_WEIGHTS.liquiditySweep > V3_WEIGHTS.liquidityPools);
  assert.ok(V3_WEIGHTS.structure > V3_WEIGHTS.sessionNarrative);
  assert.ok(V3_WEIGHTS.sessionNarrative > V3_WEIGHTS.volatility);
  assert.ok(V3_WEIGHTS.volatility > V3_WEIGHTS.momentum);
  assert.ok(V3_WEIGHTS.momentum > V3_WEIGHTS.ema);
});

test('V3.5: EARLY setup (sweep + CHoCH + compression→expansion + discount) qualifies high', () => {
  const r = scoreV3({ direction: 'long', ...earlyLong });
  assert.equal(r.direction, 'long');
  assert.equal(r.qualified, true, r.rejectionReasons.join('; '));
  assert.equal(r.earlyTrigger, true);
  assert.ok(r.score >= 70, `strong score (${r.score})`);
  // contributions sum to the score
  const sum = Math.round(Object.values(r.pillars).reduce((a, p) => a + p.contribution, 0));
  assert.equal(sum, r.score);
  // the eight V3.5 pillars are all present
  assert.deepEqual(
    Object.keys(r.pillars),
    ['liquidityIntent', 'liquiditySweep', 'liquidityPools', 'structure', 'sessionNarrative', 'volatility', 'momentum', 'ema'],
  );
});

test('V3.5: LATE entry REJECTED even with bullish EMA + strong momentum', () => {
  const r = scoreV3({ direction: 'long', ...lateLong });
  assert.equal(r.qualified, false);
  assert.equal(r.earlyTrigger, false);
  assert.ok(
    r.rejectionReasons.some((x) => /early-entry trigger/i.test(x)),
    'rejects for lack of early trigger',
  );
});

test('V3.5: premium entry penalises the liquidity-intent pillar', () => {
  const discount = scoreV3({ direction: 'long', ...earlyLong });
  const premium = scoreV3({
    direction: 'long',
    ...earlyLong,
    premiumDiscount: { enabled: true, premiumDiscountState: 'premium', premiumDiscountScore: 0.1, entryQualityPenalty: 0.9, reason: 'premium' },
  });
  assert.ok(
    premium.pillars.liquidityIntent.score01 < discount.pillars.liquidityIntent.score01,
    'buying premium scores the intent pillar lower than buying discount',
  );
});

test('V3.5: EMA is informational — opposing EMA still qualifies an early setup', () => {
  const r = scoreV3({ direction: 'long', ...earlyLong, emaAlignment: 'aligned_bearish' });
  assert.equal(r.qualified, true, r.rejectionReasons.join('; '));
  assert.equal(r.pillars.ema.weight, 4);
  assert.ok(r.pillars.ema.score01 <= 0.1, 'EMA pillar scored low but did not block');
});

test('V3.5: insufficient remaining opportunity rejects', () => {
  const r = scoreV3({ direction: 'long', ...earlyLong, targets: { accepted: false, rejectionReason: 'Insufficient remaining opportunity: nearest major liquidity 8p < 45p needed.' } });
  assert.equal(r.qualified, false);
  assert.ok(r.rejectionReasons.some((x) => /remaining opportunity/i.test(x)));
});

test('V3.5: counter-structure with no CHoCH rejects', () => {
  const r = scoreV3({
    direction: 'long',
    ...earlyLong,
    structure: { structureTrend: 'bearish', structureStrength: 70, bosDetected: false, chochDetected: false },
  });
  assert.equal(r.qualified, false);
  assert.ok(r.rejectionReasons.some((x) => /opposes/i.test(x)));
});

test('V3.5: derives its own direction from a fresh CHoCH when none forced', () => {
  const dir = deriveDirection({
    structure: { chochDetected: true, choch: { direction: 'bullish' }, structureTrend: 'bearish' },
  });
  assert.equal(dir, 'long');
  const r = scoreV3({ ...earlyLong, direction: null });
  assert.equal(r.direction, 'long');
});

test('V3.5: no directional basis yields a clean unqualified result', () => {
  const r = scoreV3({ pair: 'EUR_USD', structure: { structureTrend: 'ranging' } });
  assert.equal(r.direction, null);
  assert.equal(r.qualified, false);
  assert.equal(r.score, 0);
});
