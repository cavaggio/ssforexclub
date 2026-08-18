import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(here, '../lib/tradeLogs.ts');
let source = fs.readFileSync(target, 'utf8');

function replaceOnce(oldText, newText, label) {
  if (source.includes(newText)) return;
  if (!source.includes(oldText)) throw new Error(`PPR attribution fallback marker missing: ${label}`);
  source = source.replace(oldText, newText);
}

const attributionTypeFields =
  '  broker_trade_id?: string | null;\n' +
  '  engine?: string | null;\n' +
  '  strategy?: string | null;\n';

// First-class attribution is additive. Keep the public helper compatible with
// existing callers and fixture builders by making the new read-model fields
// optional while still writing them whenever a caller supplies them.
if (!source.includes('  engine?: string | null;')) {
  replaceOnce(
    '  brokerTradeId?: string | null;\n',
    '  brokerTradeId?: string | null;\n  engine?: string | null;\n  strategy?: string | null;\n',
    'TradeLogInput attribution fields',
  );
}
source = source.replace(
  '  broker_trade_id: string | null;\n',
  attributionTypeFields,
);

// The web runtime patch runs once for typecheck and again for build. A legacy
// generator can reinsert broker_trade_id between those passes, so collapse any
// repeated attribution type block before TypeScript sees the file.
while (source.includes(attributionTypeFields + attributionTypeFields)) {
  source = source.replace(attributionTypeFields + attributionTypeFields, attributionTypeFields);
}
source = source.replace(
  attributionTypeFields + '  broker_trade_id?: string | null;\n',
  attributionTypeFields,
);

replaceOnce(
  "        event_type: input.eventType,\n        status: input.eventType === 'error' ? 'error' : 'ok',",
  "        event_type: input.eventType,\n" +
    "        engine: input.engine ? String(input.engine).toLowerCase() : null,\n" +
    "        strategy: input.strategy ?? null,\n" +
    "        broker_trade_id: input.brokerTradeId ?? input.tradeId ?? null,\n" +
    "        status: input.eventType === 'error' ? 'error' : 'ok',",
  'attributed fallback row',
);

// Keep the fallback transform compatible with both the legacy immediate-return
// path and the newer lifecycle-aware path. Only rewrite the failed attributed
// insert itself; leave whatever success handling follows (including lifecycle
// persistence) untouched.
if (!source.includes('attributed fallback unavailable')) {
  replaceOnce(
    `      const fallback = await supabase
        .from('trade_logs')
        .insert(fallbackRow)
        .select('id')
        .single();`,
    `      let fallback = await supabase
        .from('trade_logs')
        .insert(fallbackRow)
        .select('id')
        .single();`,
    'progressive fallback declaration',
  );

  replaceOnce(
    `      if (fallback.error || !fallback.data) {
        console.warn(
          \`[TRADE_LOG] fallback insert failed user=\${input.userId} event=\${input.eventType}: \${fallback.error?.message ?? 'no row'}\`,
        );
        return { ok: false, error: fallback.error?.message ?? error?.message ?? 'no row returned' };
      }`,
    `      if (fallback.error || !fallback.data) {
        console.warn(
          \`[TRADE_LOG] attributed fallback unavailable user=\${input.userId} event=\${input.eventType}: \${fallback.error?.message ?? 'no row'} — retrying legacy fallback\`,
        );
        const {
          engine: _engine,
          strategy: _strategy,
          broker_trade_id: _brokerTradeId,
          ...legacyFallbackRow
        } = fallbackRow;
        const legacyFallback = await supabase
          .from('trade_logs')
          .insert(legacyFallbackRow)
          .select('id')
          .single();
        if (legacyFallback.error || !legacyFallback.data) {
          console.warn(
            \`[TRADE_LOG] legacy fallback insert failed user=\${input.userId} event=\${input.eventType}: \${legacyFallback.error?.message ?? 'no row'}\`,
          );
          return {
            ok: false,
            error: legacyFallback.error?.message ?? fallback.error?.message ?? error?.message ?? 'no row returned',
          };
        }
        fallback = legacyFallback;
      }`,
    'progressive fallback insert',
  );
}

for (const marker of [
  'engine?: string | null',
  'broker_trade_id?: string | null',
  'broker_trade_id: input.brokerTradeId ?? input.tradeId ?? null',
  'attributed fallback unavailable',
  'retrying legacy fallback',
]) {
  if (!source.includes(marker)) throw new Error(`PPR attribution fallback incomplete: missing ${marker}`);
}

const brokerTradeTypeCount = (source.match(/  broker_trade_id\?: string \| null;/g) || []).length;
if (brokerTradeTypeCount !== 1) {
  throw new Error(`PPR attribution fallback produced ${brokerTradeTypeCount} broker_trade_id type declarations`);
}

fs.writeFileSync(target, source);
console.log('PPR first-class attribution fallback applied.');
