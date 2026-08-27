import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const route = readFileSync(
  new URL('../app/api/cron/engine-learning-backfill/route.ts', import.meta.url),
  'utf8',
);
const service = readFileSync(new URL('./actualTradeReconciliation.ts', import.meta.url), 'utf8');
const migration = readFileSync(
  new URL('../../supabase/migrations/20260730162000_actual_trade_lifecycle_reconciliation.sql', import.meta.url),
  'utf8',
);
const queueMigration = readFileSync(
  new URL('../../supabase/migrations/20260827023000_lifecycle_backed_eod_reconciliation.sql', import.meta.url),
  'utf8',
);

test('each active OANDA account reconciles actual trades before forward studies', () => {
  assert.match(route, /for \(const account of activeAccounts\)/);
  assert.match(route, /reconcileActualTradesForAccount\(\{/);
  assert.match(route, /connectionId: account\.id/);
  assert.match(route, /brokerAccountId: account\.accountId/);
  assert.match(route, /tradingDays,/);
  assert.match(route, /for \(const engine of ENGINES as readonly Engine\[\]\)/);
  assert.ok(route.indexOf('reconcileActualTradesForAccount') < route.indexOf('backfillEngineLearningWindow({'));
});

test('historical openings are never filtered by the current ICT watchlist', () => {
  assert.match(service, /Deliberately no current-watchlist filter/);
  assert.match(service, /reconcilable_oanda_trade_openings/);
  assert.doesNotMatch(service, /configuredIctWatchlist|DEFAULT_ICT_WATCHLIST/);
  assert.match(migration, /no current-watchlist filter/i);
  assert.match(migration, /engine_attribution_source/);
});

test('nightly reconciliation is lifecycle-backed and legacy trade logs are repair-only', () => {
  assert.match(queueMigration, /actual_trade_lifecycles_reconciliation_queue_idx/);
  assert.match(queueMigration, /create or replace view public\.reconcilable_oanda_trade_openings as[\s\S]*from public\.actual_trade_lifecycles l/);
  assert.match(queueMigration, /legacy_oanda_trade_openings_repair/);
  assert.match(queueMigration, /trade_logs_direct_repair/);
  assert.match(queueMigration, /state in \('unresolved', 'open'\)/);
  assert.match(queueMigration, /actual_outcome_source = 'trade_log_close_pending_oanda_reconciliation'/);
  assert.doesNotMatch(
    queueMigration.match(/create or replace view public\.reconcilable_oanda_trade_openings as[\s\S]*?comment on view public\.reconcilable_oanda_trade_openings/)?.[0] || '',
    /to_jsonb\(/,
  );
});

test('actual broker reconciliation uses seven New York trading days with protected exceptions', () => {
  assert.match(service, /lastNewYorkTradingDayKeys/);
  assert.match(service, /tradingDays = 7/);
  assert.match(service, /tradingDaySet\.has\(key\)/);
  assert.match(service, /state\.eq\.open/);
  assert.match(service, /trade_log_close_pending_oanda_reconciliation/);
  assert.doesNotMatch(service, /calendarLookbackDays = 14/);
  assert.match(route, /calendar[\s\S]*lookback is only a discovery buffer used to locate seven executed days/);
});

test('actual outcomes are primary while forward path evidence remains supplemental', () => {
  assert.match(migration, /actual_trade_primary_forward_path_supplemental/);
  assert.match(migration, /engine_combined_pair_stats/);
  assert.match(route, /kind: 'actual_trade_lifecycle'/);
  assert.match(route, /kind: 'forward_market_path'/);
});
