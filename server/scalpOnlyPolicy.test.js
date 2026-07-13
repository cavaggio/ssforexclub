import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  HARD_SCALP_CONFIDENCE_FLOOR,
  applyScalpMetadata,
  isExplicitSwingSignal,
  normalizeScalpLifecycle,
  scalpMinConfidence,
} from './scalpOnlyPolicy.js';

test('scalp confidence can never be configured below 85', () => {
  const before = process.env.FOREX_MIN_CONFIDENCE;
  process.env.FOREX_MIN_CONFIDENCE = '70';
  assert.equal(HARD_SCALP_CONFIDENCE_FLOOR, 85);
  assert.equal(scalpMinConfidence(), 85);
  if (before == null) delete process.env.FOREX_MIN_CONFIDENCE;
  else process.env.FOREX_MIN_CONFIDENCE = before;
});

test('explicit swing labels are rejected and scalp metadata is unambiguous', () => {
  assert.equal(isExplicitSwingSignal({ tradeDuration: 'Swing' }), true);
  assert.equal(isExplicitSwingSignal({ timeframeEstimate: 'Scalp' }), false);
  const tagged = applyScalpMetadata({ strategy: 'V3' });
  assert.equal(tagged.strategy, 'V3');
  assert.equal(tagged.tradeStyle, 'SCALP');
  assert.equal(tagged.scalpOnly, true);
});

test('lifecycle target and hold are capped to scalp parameters while preserving 1.5R', () => {
  const result = normalizeScalpLifecycle({
    pair: 'EUR_USD',
    direction: 'long',
    entryPrice: 1.10000,
    atrPips: 20,
    lifecycle: {
      sl: { stopLossPips: 20, stopLossPrice: 1.09800 },
      tp: { takeProfitPips: 80, takeProfitPrice: 1.10800, targetReason: 'old swing target' },
      hold: { minMinutes: 90, maxMinutes: 360 },
    },
  });

  assert.equal(result.allowed, true);
  assert.ok(result.lifecycle.tp.takeProfitPips <= 40);
  assert.ok(result.lifecycle.tp.riskReward >= 1.5);
  assert.ok(result.lifecycle.hold.maxMinutes <= 120);
  assert.equal(result.lifecycle.tradeStyle, 'SCALP');
});

test('stop requiring a swing-sized target is rejected', () => {
  const result = normalizeScalpLifecycle({
    pair: 'EUR_USD',
    direction: 'short',
    entryPrice: 1.10000,
    atrPips: 10,
    lifecycle: {
      sl: { stopLossPips: 30, stopLossPrice: 1.10300 },
      tp: { takeProfitPips: 60, takeProfitPrice: 1.09400 },
      hold: { minMinutes: 60, maxMinutes: 180 },
    },
  });

  assert.equal(result.allowed, false);
  assert.match(result.reason, /Scalp-only reject/);
});
