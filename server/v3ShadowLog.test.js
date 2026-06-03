import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate persistence to a throwaway temp file BEFORE importing the module.
process.env.FOREX_V3_SHADOW_LOG_PATH = join(tmpdir(), `v3-shadow-test-${process.pid}.json`);
const { recordV3Shadow, generateV3ComparisonReport } = await import('./v3ShadowLog.js');

function v3Eval({ qualified, direction, score, earlyTrigger, dist, dirAgrees }) {
  return {
    qualified, direction, score, earlyTrigger,
    entryDistanceFromOriginPct: dist,
    directionAgrees: dirAgrees,
    volatility: { volatilityState: 'expanding' },
    liquidity: { liquiditySweepDetected: true },
    structure: { structureTrend: direction === 'long' ? 'bullish' : 'bearish' },
    rejectionReasons: qualified ? [] : ['no early-entry trigger'],
  };
}

test('shadow log: builds comparison rows + agreement classes', () => {
  const created = recordV3Shadow({
    qualified: [
      { pair: 'EUR_USD', direction: 'long', score: 70, confidence: 65 },
      { pair: 'USD_JPY', direction: 'short', score: 60, confidence: 55 },
    ],
    rejected: [{ pair: 'GBP_USD', reason: 'legacy reject' }],
    v3ByPair: {
      EUR_USD: v3Eval({ qualified: true, direction: 'long', score: 78, earlyTrigger: true, dist: 0.30, dirAgrees: true }),
      GBP_USD: v3Eval({ qualified: true, direction: 'long', score: 72, earlyTrigger: true, dist: 0.20, dirAgrees: false }),
      USD_JPY: v3Eval({ qualified: false, direction: 'short', score: 40, earlyTrigger: false, dist: 0.80, dirAgrees: true }),
    },
    session: 'London/NewYork Overlap',
    nowIso: '2026-06-02T13:00:00Z',
  });
  assert.equal(created.length, 3);
  const byPair = Object.fromEntries(created.map((r) => [r.pair, r]));
  assert.equal(byPair.EUR_USD.agreement, 'both');
  assert.equal(byPair.GBP_USD.agreement, 'v3_only');
  assert.equal(byPair.USD_JPY.agreement, 'legacy_only');
});

test('shadow log: report aggregates counts + timing KPI', () => {
  const report = generateV3ComparisonReport();
  assert.equal(report.counts.legacyQualified, 2);
  assert.equal(report.counts.v3Qualified, 2);
  assert.equal(report.agreement.both, 1);
  assert.equal(report.agreement.legacy_only, 1);
  assert.equal(report.agreement.v3_only, 1);
  // V3-qualified avg entry distance = mean(0.30, 0.20) = 0.25.
  assert.equal(report.timing.avgEntryDistanceFromOrigin_v3Qualified, 0.25);
  assert.equal(report.timing.earlyTriggerRate_v3Qualified, 1);
  // Expectancy is intentionally null pending resolved trades.
  assert.equal(report.expectancy.winRate_v3, null);
  assert.ok(typeof report.verdict === 'string');
});
