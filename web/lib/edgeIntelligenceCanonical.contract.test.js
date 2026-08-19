import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const routeSource = readFileSync(
  new URL('../app/api/edge-intelligence/route.ts', import.meta.url),
  'utf8',
);
const analyticsSource = readFileSync(new URL('./edgeAnalytics.ts', import.meta.url), 'utf8');

test('Edge Intelligence consumes the same canonical lifecycle as Trade Activity', () => {
  assert.match(routeSource, /canonicalizeTradeActivityRows/);
  assert.match(routeSource, /canonicalizeTradeActivityRows\(lifecycleTradeRows\(rows\)\)/);
  assert.match(routeSource, /generateAttributionReport\(lifecycleRows/);
});

test('Edge Intelligence excludes unattributable phantom rows and scores net lifecycle P\/L', () => {
  assert.match(analyticsSource, /if \(!row\.trade_id\) continue;/);
  assert.match(analyticsSource, /function netOutcome\(pnl: number \| null\)/);
  assert.match(analyticsSource, /netOutcome\(pnl\)/);
  assert.match(analyticsSource, /Partial \+ final close P\/L is combined|partial \+ final close P\/L is combined/i);
  assert.doesNotMatch(analyticsSource, /Keep them visible rather[\s\S]*standalone historical snapshot/);
});
