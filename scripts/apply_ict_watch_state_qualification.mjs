import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AUTO = path.join(ROOT, 'server', 'ictAutoTrade.js');
let source = fs.readFileSync(AUTO, 'utf8');

const oldWaitable = `function isWaitableTriggerReason(reason) {\n  const text = String(reason || '').toLowerCase();\n  return text.includes('no 5m entry-timing trigger') ||\n    text.includes('no fresh 5m impulse/structure trigger') ||\n    text.includes('await for it to turn') ||\n    text.includes('wait for it to turn') ||\n    text.includes('last completed h1 candle') ||\n    text.includes('current live h1 candle is unavailable');\n}`;
const newWaitable = `function isWaitableTriggerReason(reason) {\n  const text = String(reason || '').toLowerCase();\n  if (\n    text.includes('momentum exhausted') ||\n    text.includes('actively opposing') ||\n    text.includes('current h1 candle is actively opposing')\n  ) return false;\n  return text.includes('no 5m entry-timing trigger') ||\n    text.includes('no fresh 5m impulse/structure trigger') ||\n    text.includes('no fresh m5 continuation breakout/recovery is ready') ||\n    text.includes('waiting for the next required stage') ||\n    text.includes('await for it to turn') ||\n    text.includes('wait for it to turn') ||\n    text.includes('last completed h1 candle') ||\n    text.includes('current live h1 candle is unavailable');\n}`;
if (!source.includes(newWaitable)) {
  if (!source.includes(oldWaitable)) throw new Error('[ICT_WATCH_STATE] waitable-trigger classifier anchor missing');
  source = source.replace(oldWaitable, newWaitable);
}

// A target normalized outward to the approved minimum R:R is still executable.
// Do not remove it from the 60-second near-qualified watch merely because the
// target was adjusted; final fresh-price R:R confirmation remains authoritative.
const oldGeometry = `  if (rr < minimumRR || item?.targetAdjustedToMinRR === true) return false;`;
const newGeometry = `  if (rr < minimumRR) return false;`;
if (!source.includes(newGeometry)) {
  if (!source.includes(oldGeometry)) throw new Error('[ICT_WATCH_STATE] executable-geometry anchor missing');
  source = source.replace(oldGeometry, newGeometry);
}

// Two completed M5 bars remain fresh by the established 10-minute trigger TTL.
source = source.replace(
  'const freshTrigger = item?.freshImpulse === true || (triggerAge != null && triggerAge <= 1);',
  'const freshTrigger = item?.freshImpulse === true || (triggerAge != null && triggerAge <= 2);',
);

for (const marker of [
  "text.includes('no fresh m5 continuation breakout/recovery is ready')",
  "text.includes('waiting for the next required stage')",
  'if (rr < minimumRR) return false;',
  'triggerAge <= 2',
]) {
  if (!source.includes(marker)) throw new Error(`[ICT_WATCH_STATE] verification missing ${marker}`);
}
if (source.includes('rr < minimumRR || item?.targetAdjustedToMinRR === true')) {
  throw new Error('[ICT_WATCH_STATE] adjusted minimum-RR target is still excluded from near watch');
}

fs.writeFileSync(AUTO, source, 'utf8');
console.log('[ICT_WATCH_STATE] near-qualified monitoring preserves valid adjusted targets and waitable M5/PO3 candidates.');
