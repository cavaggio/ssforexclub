import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const routeSource = readFileSync(
  new URL('../app/api/edge-intelligence/route.ts', import.meta.url),
  'utf8',
);
const historySource = readFileSync(new URL('./edgeHistory.ts', import.meta.url), 'utf8');
const visibleTradeLogsSource = readFileSync(new URL('./visibleTradeLogs.ts', import.meta.url), 'utf8');
const analyticsSource = readFileSync(new URL('./edgeAnalytics.ts', import.meta.url), 'utf8');
const retentionSql = readFileSync(
  new URL('../../supabase/migrations/20260821144500_edge_intelligence_30d_knowledge_retention.sql', import.meta.url),
  'utf8',
);

test('Edge Intelligence uses immediate rolling 30-day account history instead of the Today trade window', () => {
  assert.match(routeSource, /loadEdgeHistoryByAccount/);
  assert.match(routeSource, /reconcile immediately on every Edge refresh/i);
  assert.doesNotMatch(routeSource, /isSameNewYorkTradingDay|newYorkDateKey/);
  assert.match(historySource, /EDGE_HISTORY_RETENTION_DAYS\s*=\s*30/);
  assert.match(historySource, /EDGE_TRADES_PER_ACCOUNT\s*=\s*300/);
  assert.match(historySource, /edge_intelligence_trade_knowledge_30d/);
  assert.match(historySource, /actual_trade_lifecycles/);
  assert.match(historySource, /trade_log_fallback/);
  assert.match(historySource, /startDate:\s*cutoffIso/);
  assert.match(historySource, /\.gte\('closed_at', cutoffIso\)/);
});

test('Trade Log fallback recovers the canonical top-level broker account before legacy payload fallbacks', () => {
  assert.match(visibleTradeLogsSource, /broker_account_id/);
  assert.match(
    visibleTradeLogsSource,
    /broker_account_id:\s*str\([\s\S]*row\.broker_account_id,[\s\S]*payload\.broker_account_id/,
  );
  assert.match(visibleTradeLogsSource, /row\.trade_id,[\s\S]*payload\.trade_id/);
});

test('Edge 30-day SQL repairs missing ICT context columns before creating the knowledge view', () => {
  assert.match(retentionSql, /alter table public\.actual_trade_lifecycles[\s\S]*add column if not exists signal_observation_id uuid/i);
  assert.match(retentionSql, /add column if not exists candidate_signal_id text/i);
  assert.match(retentionSql, /add column if not exists entry_context jsonb/i);
  assert.match(retentionSql, /add column if not exists h1_momentum jsonb/i);
  assert.match(retentionSql, /add column if not exists m5_authorization jsonb/i);
  assert.match(retentionSql, /add column if not exists applied_learning_audit_id uuid/i);
  assert.match(retentionSql, /alter table public\.signal_observations[\s\S]*add column if not exists corrective_gate jsonb/i);
  assert.match(retentionSql, /alter table public\.engine_learning_adjustment_audit[\s\S]*add column if not exists adjustment_type text/i);
  assert.match(retentionSql, /on observation\.id = lifecycle\.signal_observation_id/i);
});

test('Edge 30-day SQL enriches knowledge and expires stale learning/storage data', () => {
  assert.match(retentionSql, /create or replace view public\.edge_intelligence_trade_knowledge_30d/i);
  assert.match(retentionSql, /h1_momentum/i);
  assert.match(retentionSql, /m5_authorization/i);
  assert.match(retentionSql, /po3_stage/i);
  assert.match(retentionSql, /mfe_r/i);
  assert.match(retentionSql, /failure_reasons/i);
  assert.match(retentionSql, /impulseLifecycle/i);
  assert.match(retentionSql, /now\(\) - interval '30 days'/i);
  assert.match(retentionSql, /purge_edge_intelligence_expired_data/i);
  assert.match(retentionSql, /state <> 'open'/i);
  assert.match(retentionSql, /cron\.schedule/i);
});

test('Edge Intelligence excludes unattributable phantom rows and scores net lifecycle P\/L', () => {
  assert.match(analyticsSource, /if \(!row\.trade_id\) continue;/);
  assert.match(analyticsSource, /function netOutcome\(pnl: number \| null\)/);
  assert.match(analyticsSource, /netOutcome\(pnl\)/);
  assert.match(analyticsSource, /Partial \+ final close P\/L is combined|partial \+ final close P\/L is combined/i);
  assert.doesNotMatch(analyticsSource, /Keep them visible rather[\s\S]*standalone historical snapshot/);
});
