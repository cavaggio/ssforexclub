import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = path.join(ROOT, 'server', 'ictEngine.js');
const CONTINUATION = path.join(ROOT, 'server', 'ictContinuationEntry.js');

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

let continuation = fs.readFileSync(CONTINUATION, 'utf8');

// OANDA M5 candle timestamps identify the candle start. Trigger age begins when
// the completed candle confirms five minutes later, not at its opening timestamp.
continuation = replaceOnce(
  continuation,
  `  const eventMs = parseMs(eventTime);\n  const nowMs = now instanceof Date ? now.getTime() : parseMs(now);\n  if (Number.isFinite(eventMs) && Number.isFinite(nowMs) && nowMs >= eventMs) {\n    return +((nowMs - eventMs) / 60_000).toFixed(2);\n  }`,
  `  const eventMs = parseMs(eventTime);\n  const nowMs = now instanceof Date ? now.getTime() : parseMs(now);\n  const confirmedAtMs = Number.isFinite(eventMs) ? eventMs + (5 * 60_000) : null;\n  if (Number.isFinite(confirmedAtMs) && Number.isFinite(nowMs)) {\n    if (nowMs <= confirmedAtMs) return 0;\n    return +((nowMs - confirmedAtMs) / 60_000).toFixed(2);\n  }`,
  'M5 close-based trigger age',
);

// An external BOS/range label must still represent a decisive breakout. FVG/OB
// is no longer mandatory, but a tiny close through structure cannot authorize.
continuation = insertAfter(
  continuation,
  `  const externalIndex = externalTime\n    ? completed.findIndex((candle) => candle?.time === externalTime)\n    : completed.length - 1;\n`,
  `  const externalCandle = externalIndex >= 0 ? completed[externalIndex] : null;\n  const externalBody = externalCandle\n    ? Math.abs(finite(externalCandle.close) - finite(externalCandle.open))\n    : null;\n  const externalBodyAtr = Number.isFinite(externalBody) && Number.isFinite(atrValue) && atrValue > 0\n    ? externalBody / atrValue\n    : null;\n  const externalDecisive = displacementAligned || (Number.isFinite(externalBodyAtr) && externalBodyAtr >= 0.35);\n`,
  'decisive external breakout requirement',
);
continuation = replaceOnce(
  continuation,
  `  const externalEvent = Number.isFinite(externalLevel) && externalIsCompleted && externalIndex >= 0`,
  `  const externalEvent = Number.isFinite(externalLevel) && externalIsCompleted && externalIndex >= 0 && externalDecisive`,
  'decisive external breakout gate',
);

// Recovery means an actual held retest. A normal breakout from compression is
// still a breakout; otherwise it can accidentally bypass the anti-chase branch.
continuation = replaceOnce(
  continuation,
  `  const mode = retestEvent\n    ? 'm5_continuation_recovery'\n    : breakoutEvent\n      ? (recoveryFromPullback ? 'm5_continuation_recovery' : 'm5_continuation_breakout')\n      : null;`,
  `  const mode = retestEvent\n    ? 'm5_continuation_recovery'\n    : breakoutEvent ? 'm5_continuation_breakout' : null;`,
  'recovery-only-on-retest classification',
);
continuation = replaceOnce(
  continuation,
  `  } else if (overextended && mode !== 'm5_continuation_recovery') {`,
  `  } else if (overextended) {`,
  'anti-chase applies to recovery too',
);
fs.writeFileSync(CONTINUATION, continuation);

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
for (const required of [
  'confirmedAtMs',
  'externalDecisive',
  "breakoutEvent ? 'm5_continuation_breakout' : null",
  '} else if (overextended) {',
]) {
  if (!continuation.includes(required)) throw new Error(`[ICT_BREAKOUT_RECOVERY] continuation verification missing ${required}`);
}

console.log('ICT breakout recovery applied: 10-minute fresh trigger retention, session-aware H1 confirmation, and pullback/retest recovery.');

// Apply the additive H1 impulse lifecycle guard after all existing ICT runtime
// transforms so it cannot change or be overwritten by the earlier strategy patches.
await import('./apply_ict_impulse_lifecycle.mjs');

// Final fail-loud timing/qualification contract. This intentionally runs last so
// legacy source generators cannot reintroduce universal PO3/D1-H4 bottlenecks or
// the retired 02:00-10:00 live window during Railway/Vercel prestart.
await import('./apply_ict_qualification_contract.mjs');
