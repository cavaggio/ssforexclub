import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(ROOT, 'scripts/apply_account_engine_isolation.mjs');
let source = readFileSync(target, 'utf8');

const legacy = `function replaceRequired(source, before, after, label) {
  if (source.includes(after)) return source;
  if (!source.includes(before)) throw new Error(\`[ACCOUNT_ENGINE_ISOLATION] missing \${label}\`);
  return source.replace(before, after);
}`;

const compatible = `function replaceRequired(source, before, after, label) {
  if (source.includes(after)) return source;
  if (!source.includes(before)) {
    if (
      label === 'ICT hard scan watchlist' &&
      source.includes('const hardWatchlist = configuredIctWatchlist();') &&
      source.includes('hard-watchlist blocked pairs=') &&
      source.includes('ICT hard watchlist rejected every requested pair')
    ) return source;
    if (
      label === 'ICT execution watchlist gate' &&
      source.includes('const hardWatchlist = configuredIctWatchlist();') &&
      source.includes('ICT hard watchlist rejected')
    ) return source;
    throw new Error(\`[ACCOUNT_ENGINE_ISOLATION] missing \${label}\`);
  }
  return source.replace(before, after);
}`;

if (source.includes(legacy)) {
  source = source.replace(legacy, compatible);
  writeFileSync(target, source, 'utf8');
  console.log('[ICT_A_GRADE_COMPAT] account isolation recognizes existing centralized ICT watchlist gates');
} else if (source.includes("label === 'ICT hard scan watchlist'")) {
  console.log('[ICT_A_GRADE_COMPAT] account isolation watchlist compatibility already prepared');
} else {
  throw new Error('[ICT_A_GRADE_COMPAT] account isolation replaceRequired helper not found');
}
