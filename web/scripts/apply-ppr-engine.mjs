import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

function update(relativePath, transform) {
  const path = resolve(ROOT, relativePath);
  const before = readFileSync(path, 'utf8');
  const after = transform(before);
  if (after !== before) writeFileSync(path, after, 'utf8');
}

function replaceOnce(source, before, after, label) {
  if (source.includes(after)) return source;
  if (!source.includes(before)) throw new Error(`PPR web patch missing ${label}`);
  return source.replace(before, after);
}

update('lib/tradeLogs.ts', (input) => {
  let source = input;
  source = replaceOnce(
    source,
    "  brokerOrderId?: string | null;",
    "  brokerOrderId?: string | null;\n  brokerTradeId?: string | null;",
    'brokerTradeId input',
  );
  source = replaceOnce(
    source,
    "      broker_order_id:   input.brokerOrderId ?? null,",
    "      broker_order_id:   input.brokerOrderId ?? null,\n      broker_trade_id:   input.brokerTradeId ?? input.tradeId ?? null,",
    'broker trade insert',
  );
  source = replaceOnce(
    source,
    "    broker_order_id: null,",
    "    broker_order_id: null,\n    broker_trade_id: (r.broker_trade_id as string | null) ?? null,",
    'broker trade map',
  );
  source = replaceOnce(
    source,
    "  broker_order_id: string | null;",
    "  broker_order_id: string | null;\n  broker_trade_id: string | null;",
    'broker trade row type',
  );
  source = replaceOnce(
    source,
    "const TRADE_LOG_SELECT =\n  'id, user_id, created_at, event_type, status, pair, direction, ' +\n  'entry_price, exit_price, realized_pl, unrealized_pl, payload, raw_payload';",
    "const TRADE_LOG_SELECT_ATTRIBUTED =\n  'id, user_id, created_at, event_type, status, pair, direction, engine, strategy, broker_trade_id, ' +\n  'entry_price, exit_price, realized_pl, unrealized_pl, payload, raw_payload';\nconst TRADE_LOG_SELECT_LEGACY =\n  'id, user_id, created_at, event_type, status, pair, direction, ' +\n  'entry_price, exit_price, realized_pl, unrealized_pl, payload, raw_payload';",
    'progressive trade log selects',
  );
  const oldQuery = `    let q = supabase
      .from('trade_logs')
      .select(TRADE_LOG_SELECT)
        .in('status', ['OPENED', 'CLOSED', 'ERROR', 'opened', 'closed', 'error'])
      .eq('user_id', clerkUserId);
    if (filters.instrument) q = q.eq('pair', normalizeInstrument(filters.instrument)); // prod column is \`pair\`
    if (filters.eventType)  q = q.eq('event_type', filters.eventType);
    if (filters.startDate)  q = q.gte('created_at', filters.startDate);
    if (filters.endDate)    q = q.lte('created_at', filters.endDate);
    if (filters.cursor)     q = q.lt('created_at',  filters.cursor);
    q = q.order('created_at', { ascending: false }).limit(limit + 1);
    const { data, error } = await q;
    if (error) {
      console.warn(\`[TRADE_LOG] listTradeLogsForUser query failed (non-fatal): \${error.message}\`);
      return { rows: [], nextCursor: null };
    }
    const all = ((data ?? []) as unknown as Record<string, unknown>[]).map(mapRow);`;
  const newQuery = `    const buildQuery = (selectColumns: string, attributed: boolean) => {
      let q = supabase
        .from('trade_logs')
        .select(selectColumns)
        .in('status', ['OPENED', 'CLOSED', 'ERROR', 'opened', 'closed', 'error'])
        .eq('user_id', clerkUserId);
      if (filters.instrument) q = q.eq('pair', normalizeInstrument(filters.instrument));
      if (filters.eventType)  q = q.eq('event_type', filters.eventType);
      if (filters.startDate)  q = q.gte('created_at', filters.startDate);
      if (filters.endDate)    q = q.lte('created_at', filters.endDate);
      if (filters.cursor)     q = q.lt('created_at', filters.cursor);
      if (filters.tradeId && attributed) q = q.eq('broker_trade_id', filters.tradeId);
      return q.order('created_at', { ascending: false }).limit(limit + 1);
    };

    let { data, error } = await buildQuery(TRADE_LOG_SELECT_ATTRIBUTED, true);
    if (error) {
      console.warn(\`[TRADE_LOG] attributed select unavailable; retrying legacy schema: \${error.message}\`);
      ({ data, error } = await buildQuery(TRADE_LOG_SELECT_LEGACY, false));
    }
    if (error) {
      console.warn(\`[TRADE_LOG] listTradeLogsForUser query failed (non-fatal): \${error.message}\`);
      return { rows: [], nextCursor: null };
    }
    const mapped = ((data ?? []) as unknown as Record<string, unknown>[]).map(mapRow);
    const all = filters.tradeId
      ? mapped.filter((row) => row.broker_trade_id === filters.tradeId || row.trade_id === filters.tradeId)
      : mapped;`;

  source = replaceOnce(source, oldQuery, newQuery, 'progressive trade log query');

  for (const marker of [
    'brokerTradeId?: string | null',
    'broker_trade_id:   input.brokerTradeId',
    'TRADE_LOG_SELECT_ATTRIBUTED',
    'attributed select unavailable',
  ]) {
    if (!source.includes(marker)) throw new Error(`PPR trade-log integration incomplete: missing ${marker}`);
  }
  return source;
});

update('app/api/cron/active-trade-management/route.ts', (input) => {
  let source = input;
  source = replaceOnce(
    source,
    "    raw.engine ?? raw.strategy ?? item.engine ?? item.strategy ?? signal.engine ?? signal.strategy ?? '',",
    "    row.engine ?? row.strategy ?? raw.engine ?? raw.strategy ?? item.engine ?? item.strategy ?? signal.engine ?? signal.strategy ?? '',",
    'first-class strategy reader',
  );
  source = replaceOnce(
    source,
    "    row.trade_id ?? raw.tradeId ?? raw.trade_id ?? item.tradeId ?? item.trade_id ??",
    "    row.broker_trade_id ?? row.trade_id ?? raw.tradeId ?? raw.trade_id ?? item.tradeId ?? item.trade_id ??",
    'first-class broker trade reader',
  );

  // PPR remains broker-native SL/TP only. Active Exit Intelligence is enabled
  // for ICT/V3 and must not accidentally activate PPR management.
  source = source
    .replace(
      "          skipped: 'ppr_native_management_not_configured_sl_tp_only',",
      "          skipped: 'ppr_automated_management_disabled_manual_only',",
    )
    .replace(
      "evaluations.push({ tradeId, instrument: plan.instrument, engine: tradeEngine, skipped: 'ppr_sl_tp_only' });",
      "evaluations.push({ tradeId, instrument: plan.instrument, engine: tradeEngine, skipped: 'ppr_automated_management_disabled_manual_only' });",
    );

  for (const marker of [
    'row.engine ?? row.strategy',
    'row.broker_trade_id ?? row.trade_id',
    'ppr_automated_management_disabled_manual_only',
  ]) {
    if (!source.includes(marker)) throw new Error(`PPR active-management integration incomplete: missing ${marker}`);
  }
  return source;
});

console.log('PPR web cron, trade attribution, and management isolation applied.');
