import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '..');

function update(relativePath, transform) {
  const filePath = path.resolve(webRoot, relativePath);
  const original = fs.readFileSync(filePath, 'utf8');
  const next = transform(original);
  fs.writeFileSync(filePath, next);
}

function replaceOnce(source, oldText, newText, label) {
  if (source.includes(newText)) return source;
  if (!source.includes(oldText)) throw new Error(`PPR web integration marker missing: ${label}`);
  return source.replace(oldText, newText);
}

update('app/api/cron/auto-ai-trading/route.ts', (input) => {
  let source = input;
  source = replaceOnce(
    source,
    "type ScanMode = 'full' | 'near_recheck' | 'hot_watch';",
    "type ScanMode = 'full' | 'near_recheck' | 'hot_watch';\ntype AutoAiEngine = 'ict' | 'v3' | 'ppr';",
    'engine type',
  );
  source = replaceOnce(
    source,
    "function normalizePairs(value: unknown): string[] {",
    "function normalizeEngine(value: unknown): AutoAiEngine {\n  if (value === 'v3' || value === 'ppr') return value;\n  return 'ict';\n}\n\nfunction normalizePairs(value: unknown): string[] {",
    'engine normalizer',
  );
  source = source.replace(
    '// Retains the currently deployed 02:15–11:00 ET entry window. The separate\n// 2:00 PM entry/5:00 PM management change remains isolated from this correction.',
    '// Auto AI entry execution is restricted to 02:00–10:00 ET, Monday–Friday.',
  );
  source = replaceOnce(
    source,
    '  return minutes >= 135 && minutes < 660;',
    '  return minutes >= 120 && minutes < 600;',
    'entry window',
  );
  source = replaceOnce(
    source,
    "    const engine = row.auto_ai_engine === 'v3' ? 'v3' : 'ict';",
    '    const engine = normalizeEngine(row.auto_ai_engine);',
    'scheduled engine selection',
  );
  source = source.replace(
    "            mode: 'not_applicable_to_ict',",
    "            mode: `not_applicable_to_${engine}`,",
  );
  source = source.replace(
    "            reason: 'V3 account Edge priority is not applied to ICT.',",
    "            reason: `V3 account Edge priority is not applied to ${engine.toUpperCase()}.`,",
  );
  source = source.replace(
    "              : 'V3_AUTO',",
    "              : `${engine.toUpperCase()}_AUTO`,",
  );
  source = replaceOnce(
    source,
    "          eventType: 'opened',\n          instrument:",
    "          eventType: 'opened',\n" +
      "          engine,\n" +
      "          strategy: typeof executed.strategy === 'string' ? executed.strategy : engine.toUpperCase(),\n" +
      "          brokerTradeId: typeof executed.tradeId === 'string' ? executed.tradeId : null,\n" +
      "          instrument:",
    'first-class trade attribution writer',
  );

  for (const marker of [
    "type AutoAiEngine = 'ict' | 'v3' | 'ppr'",
    "value === 'v3' || value === 'ppr'",
    'minutes >= 120 && minutes < 600',
    'const engine = normalizeEngine(row.auto_ai_engine)',
    'brokerTradeId:',
  ]) {
    if (!source.includes(marker)) throw new Error(`PPR web cron integration incomplete: missing ${marker}`);
  }
  return source;
});

update('lib/tradeLogs.ts', (input) => {
  let source = input;
  source = replaceOnce(
    source,
    "  eventType: TradeEventType;\n  instrument?: string | null;",
    "  eventType: TradeEventType;\n" +
      "  engine?: string | null;\n" +
      "  strategy?: string | null;\n" +
      "  brokerTradeId?: string | null;\n" +
      "  instrument?: string | null;",
    'trade log input attribution',
  );
  source = replaceOnce(
    source,
    "      event_type:        input.eventType,\n      side:",
    "      event_type:        input.eventType,\n" +
      "      engine:            input.engine ? String(input.engine).toLowerCase() : null,\n" +
      "      strategy:          input.strategy ?? null,\n" +
      "      broker_trade_id:   input.brokerTradeId ?? input.tradeId ?? null,\n" +
      "      side:",
    'primary trade log attribution insert',
  );
  source = replaceOnce(
    source,
    "          environment: input.environment,\n          trade_id:",
    "          environment: input.environment,\n" +
      "          engine: input.engine ? String(input.engine).toLowerCase() : null,\n" +
      "          strategy: input.strategy ?? null,\n" +
      "          broker_trade_id: input.brokerTradeId ?? input.tradeId ?? null,\n" +
      "          trade_id:",
    'fallback payload attribution',
  );
  source = replaceOnce(
    source,
    "  event_type: TradeEventType;\n  instrument: string | null;",
    "  event_type: TradeEventType;\n" +
      "  engine: string | null;\n" +
      "  strategy: string | null;\n" +
      "  broker_trade_id: string | null;\n" +
      "  instrument: string | null;",
    'trade log row attribution',
  );
  source = replaceOnce(
    source,
    "const TRADE_LOG_SELECT =\n" +
      "  'id, user_id, created_at, event_type, status, pair, direction, ' +\n" +
      "  'entry_price, exit_price, realized_pl, unrealized_pl, payload, raw_payload';",
    "const TRADE_LOG_SELECT_ATTRIBUTED =\n" +
      "  'id, user_id, created_at, event_type, status, engine, strategy, broker_trade_id, pair, direction, ' +\n" +
      "  'entry_price, exit_price, realized_pl, unrealized_pl, payload, raw_payload';\n" +
      "const TRADE_LOG_SELECT_LEGACY =\n" +
      "  'id, user_id, created_at, event_type, status, pair, direction, ' +\n" +
      "  'entry_price, exit_price, realized_pl, unrealized_pl, payload, raw_payload';",
    'progressive trade log selects',
  );
  source = replaceOnce(
    source,
    "    event_type: r.event_type as TradeEventType,\n    instrument:",
    "    event_type: r.event_type as TradeEventType,\n" +
      "    engine: typeof r.engine === 'string' ? r.engine : null,\n" +
      "    strategy: typeof r.strategy === 'string' ? r.strategy : null,\n" +
      "    broker_trade_id: typeof r.broker_trade_id === 'string' ? r.broker_trade_id : null,\n" +
      "    instrument:",
    'trade log row mapper attribution',
  );
  source = source.replace(
    "    trade_id: null,\n    broker_order_id: null,",
    "    trade_id: typeof r.broker_trade_id === 'string' ? r.broker_trade_id : null,\n" +
      "    broker_order_id: typeof r.broker_trade_id === 'string' ? r.broker_trade_id : null,",
  );

  const oldQuery = `    const supabase = getServerSupabase();
    let q = supabase
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

  const newQuery = `    const supabase = getServerSupabase();
    const buildQuery = (columns: string, attributed: boolean) => {
      let q = supabase
        .from('trade_logs')
        .select(columns)
        .in('status', ['OPENED', 'CLOSED', 'ERROR', 'opened', 'closed', 'error'])
        .eq('user_id', clerkUserId);
      if (filters.instrument) q = q.eq('pair', normalizeInstrument(filters.instrument));
      if (filters.eventType) q = q.eq('event_type', filters.eventType);
      if (filters.tradeId && attributed) q = q.eq('broker_trade_id', filters.tradeId);
      if (filters.startDate) q = q.gte('created_at', filters.startDate);
      if (filters.endDate) q = q.lte('created_at', filters.endDate);
      if (filters.cursor) q = q.lt('created_at', filters.cursor);
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
  source = source.replace(
    "          skipped: 'ppr_native_management_not_configured_sl_tp_only',",
    "          skipped: 'ppr_automated_management_disabled_after_10am_manual_only',",
  );

  for (const marker of [
    'row.engine ?? row.strategy',
    'row.broker_trade_id ?? row.trade_id',
    'ppr_automated_management_disabled_after_10am_manual_only',
  ]) {
    if (!source.includes(marker)) throw new Error(`PPR active-management integration incomplete: missing ${marker}`);
  }
  return source;
});

console.log('PPR web cron, trade attribution, and management isolation applied.');
