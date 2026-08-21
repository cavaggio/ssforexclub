import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const routeSource = readFileSync(
  new URL('../app/api/edge-intelligence/route.ts', import.meta.url),
  'utf8',
);
const historySource = readFileSync(new URL('./edgeHistory.ts', import.meta.url), 'utf8');
const analyticsSource = readFileSync(new URL('./edgeAnalytics.ts', import.meta.url), 'utf8');

test('Edge Intelligence uses persistent account history instead of the Today trade window', () => {
  assert.match(routeSource, /loadEdgeHistoryByAccount/);
  assert.doesNotMatch(routeSource, /isSameNewYorkTradingDay|newYorkDateKey/);
  assert.match(historySource, /EDGE_TRADES_PER_ACCOUNT\s*=\s*25/);
  assert.match(historySource, /actual_trade_lifecycles/);
  assert.match(historySource, /trade_log_fallback/);
  assert.match(historySource, /listVisibleTradeLogsForUser/);
});

test('Edge Intelligence excludes unattributable phantom rows and scores net lifecycle P\/L', () => {
  assert.match(analyticsSource, /if \(!row\.trade_id\) continue;/);
  assert.match(analyticsSource, /function netOutcome\(pnl: number \| null\)/);
  assert.match(analyticsSource, /netOutcome\(pnl\)/);
  assert.match(analyticsSource, /Partial \+ final close P\/L is combined|partial \+ final close P\/L is combined/i);
  assert.doesNotMatch(analyticsSource, /Keep them visible rather[\s\S]*standalone historical snapshot/);
});
