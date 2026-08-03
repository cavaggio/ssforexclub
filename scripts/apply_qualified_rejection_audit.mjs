import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function replaceRequired(source, before, after, label) {
  if (source.includes(after)) return source;
  if (!source.includes(before)) throw new Error(`[QUALIFIED_REJECTION_AUDIT] missing ${label}`);
  return source.replace(before, after);
}

export function patchQualifiedRejectionAudit(source) {
  let out = source;
  if (!out.includes("executionSource: 'auto_ai_qualified_rejection'")) {
    out = replaceRequired(
      out,
      "        const executedList = Array.isArray(payload.executed) ? payload.executed : [];\n",
      `        const executedList = Array.isArray(payload.executed) ? payload.executed : [];
        const skippedList = Array.isArray(payload.skipped) ? payload.skipped : [];
        const analysesByPair = new Map<string, Record<string, any>>(
          (Array.isArray(payload.results) ? payload.results : [])
            .filter((item: any) => typeof item?.pair === 'string')
            .map((item: any) => [String(item.pair).toUpperCase(), item]),
        );
`,
      'qualified skipped-list capture',
    );

    const insertionPoint = `        results.push({
          user: row.user_id,
          selectedEngine,
`;
    const auditBlock = `        // Persist every scanner-qualified execution rejection. Historically only
        // successful opens were logged, which made false hard-gate misses
        // impossible to reconstruct after the scan response expired.
        for (const item of skippedList) {
          const pair = typeof item?.pair === 'string' ? String(item.pair).toUpperCase() : null;
          const signal = pair ? analysesByPair.get(pair) ?? null : null;
          const direction = item?.direction === 'long' || item?.direction === 'short'
            ? item.direction
            : signal?.signal === 'buy'
              ? 'long'
              : signal?.signal === 'sell'
                ? 'short'
                : null;
          const reason = typeof item?.reason === 'string'
            ? item.reason
            : 'Qualified execution was skipped without a concrete reason.';

          await logTradeEvent({
            userId: row.user_id,
            broker: (resolved.activeBroker ?? 'oanda') as 'oanda',
            brokerAccountId: credentials.accountId,
            environment: resolved.activeEnvironment as 'practice' | 'live' | 'paper',
            eventType: 'error',
            instrument: pair,
            side: direction,
            entryPrice: typeof signal?.entry === 'number' ? signal.entry : null,
            sl: typeof signal?.stopLoss === 'number' ? signal.stopLoss : null,
            tp: typeof signal?.target1 === 'number' ? signal.target1 : null,
            confidence: typeof signal?.confidence === 'number' ? signal.confidence : null,
            recommendation: \`\${selectedEngine.toUpperCase()} qualified execution rejected\`,
            reason,
            rawPayload: {
              executionSource: 'auto_ai_qualified_rejection',
              runId,
              scanMode,
              engine: selectedEngine,
              accounting,
              rejection: item,
              signal,
            },
            edge: signal ? edgeSnapshotFromSignal(signal) : null,
          });
        }

${insertionPoint}`;
    out = replaceRequired(out, insertionPoint, auditBlock, 'qualified rejection audit loop');
  }

  const required = [
    'const skippedList = Array.isArray(payload.skipped)',
    'executionSource: \'auto_ai_qualified_rejection\'',
    'qualified execution rejected',
    'rejection: item',
  ];
  const missing = required.filter((marker) => !out.includes(marker));
  if (missing.length) {
    throw new Error(`[QUALIFIED_REJECTION_AUDIT] route markers missing: ${missing.join(', ')}`);
  }
  return out;
}

export function applyQualifiedRejectionAudit(root = DEFAULT_ROOT) {
  const path = resolve(root, 'web/app/api/cron/auto-ai-trading-extended/route.ts');
  if (!existsSync(path)) return [];
  const before = readFileSync(path, 'utf8');
  const after = patchQualifiedRejectionAudit(before);
  if (after !== before) writeFileSync(path, after, 'utf8');
  console.log(`[QUALIFIED_REJECTION_AUDIT] verified web/app/api/cron/auto-ai-trading-extended/route.ts${after !== before ? ' (patched)' : ''}`);
  return after !== before ? ['web/app/api/cron/auto-ai-trading-extended/route.ts'] : [];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  applyQualifiedRejectionAudit();
}
