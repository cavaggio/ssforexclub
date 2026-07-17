import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const routePath = path.resolve(here, '../app/api/cron/auto-ai-trading/route.ts');
let source = fs.readFileSync(routePath, 'utf8');

function replaceOnce(oldText, newText, label) {
  if (source.includes(newText)) return;
  if (!source.includes(oldText)) throw new Error(`PPR web integration marker missing: ${label}`);
  source = source.replace(oldText, newText);
}

replaceOnce(
  "type ScanMode = 'full' | 'near_recheck' | 'hot_watch';",
  "type ScanMode = 'full' | 'near_recheck' | 'hot_watch';\ntype AutoAiEngine = 'ict' | 'v3' | 'ppr';",
  'engine type',
);
replaceOnce(
  "function normalizePairs(value: unknown): string[] {",
  "function normalizeEngine(value: unknown): AutoAiEngine {\n  if (value === 'v3' || value === 'ppr') return value;\n  return 'ict';\n}\n\nfunction normalizePairs(value: unknown): string[] {",
  'engine normalizer',
);
source = source.replace(
  '// Retains the currently deployed 02:15–11:00 ET entry window. The separate\n// 2:00 PM entry/5:00 PM management change remains isolated from this correction.',
  '// Auto AI entry execution is restricted to 02:00–10:00 ET, Monday–Friday.',
);
replaceOnce(
  '  return minutes >= 135 && minutes < 660;',
  '  return minutes >= 120 && minutes < 600;',
  'entry window',
);
replaceOnce(
  "    const engine = row.auto_ai_engine === 'v3' ? 'v3' : 'ict';",
  '    const engine = normalizeEngine(row.auto_ai_engine);',
  'scheduled engine selection',
);
source = source.replace("            mode: 'not_applicable_to_ict',", "            mode: `not_applicable_to_${engine}`,",);
source = source.replace("            reason: 'V3 account Edge priority is not applied to ICT.',", "            reason: `V3 account Edge priority is not applied to ${engine.toUpperCase()}.`,",);
source = source.replace("              : 'V3_AUTO',", "              : `${engine.toUpperCase()}_AUTO`,",);

for (const marker of [
  "type AutoAiEngine = 'ict' | 'v3' | 'ppr'",
  "value === 'v3' || value === 'ppr'",
  'minutes >= 120 && minutes < 600',
  'const engine = normalizeEngine(row.auto_ai_engine)',
]) {
  if (!source.includes(marker)) throw new Error(`PPR web integration incomplete: missing ${marker}`);
}

fs.writeFileSync(routePath, source);
console.log('PPR web cron integration applied.');
