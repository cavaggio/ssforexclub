import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = path.join(ROOT, 'server', 'ictEngine.js');

function replaceOnce(source, before, after, label) {
  if (source.includes(after)) return source;
  if (!source.includes(before)) throw new Error(`[ICT_BREAKOUT_RECOVERY] missing ${label}`);
  return source.replace(before, () => after);
}

function insertAfter(source, anchor, addition, label) {
  if (source.includes(addition.trim())) return source;
  if (!source.includes(anchor)) throw new Error(`[ICT_BREAKOUT_RECOVERY] missing ${label}`);
  return source.replace(anchor, () => `${anchor}${addition}`);
}

let engine = fs.readFileSync(ENGINE, 'utf8');

// Feed the completed 01:00-03:00 ET narrative and wall-clock scan time into the
// continuation classifier. This lets it retain a just-closed breakout across the
// next live M5 candle and calculate an exact trigger age.
engine = replaceOnce(
  engine,
  `    h1Momentum,\n    h1Transition,\n    bos,`,
  `    h1Momentum,\n    h1Transition,\n    earlySessionDirection,\n    now,\n    bos,`,
  'continuation session/time inputs',
);

// A retained fresh breakout/recovery authorization is itself an actionable M5
// trigger. Do not require one of the old current-bar detector booleans to also
// remain true after the breakout candle has closed.
engine = replaceOnce(
  engine,
  `  const entryTrigger = sweepAligned || displacementAligned || reversalConfirmed || bosAligned ||\n    rangeBreakoutAligned || retestAligned || fvgInDir || obInDir || inOteZone ||`,
  `  const entryTrigger = continuationBreakout.ready || sweepAligned || displacementAligned || reversalConfirmed || bosAligned ||\n    rangeBreakoutAligned || retestAligned || fvgInDir || obInDir || inOteZone ||`,
  'retained continuation trigger',
);

// Carry the actual breakout age into the universal freshness diagnostic. Two M5
// bars = 10 minutes, matching the continuation classifier's authorization TTL.
engine = insertAfter(
  engine,
  `  const triggerAges = [\n`,
  `    Number.isFinite(continuationBreakout?.triggerAgeBars) ? continuationBreakout.triggerAgeBars : null,\n`,
  'continuation trigger age',
);
engine = replaceOnce(
  engine,
  `  const freshImpulse = Number.isFinite(triggerAgeBars) && triggerAgeBars <= 1;`,
  `  const freshImpulse = Number.isFinite(triggerAgeBars) && triggerAgeBars <= 2;`,
  '10-minute M5 freshness window',
);

engine = replaceOnce(
  engine,
  `    h1Momentum,\n    h1Transition,\n    entryAuthorization,`,
  `    h1Momentum,\n    h1Transition,\n    earlySessionDirection,\n    entryAuthorization,`,
  'corrective-gate session context',
);

// Surface recovery state in the scan concepts/activity log so a skipped chase is
// distinguishable from a dead setup. This gives the learning loop a clear record
// that the trend remained armed for a pullback/re-break.
engine = insertAfter(
  engine,
  `  if (continuationBreakout.ready) note(\n    continuationBreakout.mode === 'm5_continuation_retest'\n      ? 'M5 continuation retest authorized'\n      : 'M5 continuation breakout authorized',\n  );\n`,
  `  if (continuationBreakout.recoveryArmed && !continuationBreakout.ready) note('M5 continuation recovery armed');\n`,
  'recovery diagnostic note',
);

fs.writeFileSync(ENGINE, engine);

for (const required of [
  'earlySessionDirection,\n    now,\n    bos,',
  'const entryTrigger = continuationBreakout.ready ||',
  'continuationBreakout?.triggerAgeBars',
  'triggerAgeBars <= 2',
  'M5 continuation recovery armed',
]) {
  if (!engine.includes(required)) throw new Error(`[ICT_BREAKOUT_RECOVERY] verification missing ${required}`);
}

console.log('ICT breakout recovery applied: 10-minute fresh trigger retention, session-aware H1 confirmation, and pullback/re-break recovery.');
