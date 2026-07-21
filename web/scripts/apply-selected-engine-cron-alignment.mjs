import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const routePath = resolve(process.cwd(), 'app/api/cron/auto-ai-trading/route.ts');
let source = readFileSync(routePath, 'utf8');

source = source.replace(
  'return minutes >= 135 && minutes < 660;',
  'return minutes >= 120 && minutes < 600;',
);
source = source.replace(
  "const engine = row.auto_ai_engine === 'v3' ? 'v3' : 'ict';",
  "const engine = row.auto_ai_engine === 'v3'\n" +
    "      ? 'v3'\n" +
    "      : row.auto_ai_engine === 'ppr'\n" +
    "        ? 'ppr'\n" +
    "        : 'ict';",
);
source = source.replace(
  'Retains the currently deployed 02:15–11:00 ET entry window.',
  'Scanning begins at 02:00 ET; the engine-neutral router blocks new orders until 02:15 ET.',
);

for (const marker of [
  'return minutes >= 120 && minutes < 600;',
  "row.auto_ai_engine === 'ppr'",
]) {
  if (!source.includes(marker)) {
    throw new Error(`selected-engine cron alignment incomplete: missing ${marker}`);
  }
}

writeFileSync(routePath, source);
console.log('Web Auto AI cron aligned: selected engine only, scan at 02:00, execute at 02:15');
