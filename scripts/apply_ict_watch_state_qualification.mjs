import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AUTO = path.join(ROOT, 'server', 'ictAutoTrade.js');
const ENGINE = path.join(ROOT, 'server', 'ictEngine.js');
const MARKET_MAKER = path.join(ROOT, 'server', 'ictMarketMakerModel.js');
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

// ---------------------------------------------------------------------------
// Remove the current-day studied-reversal-direction requirement.
//
// The 02:00 ET study remains mandatory. What is removed is the extra requirement
// that a split D1/H4 market already have a reversal direction persisted by that
// study before the live ICT engine can evaluate the reversal sequence.
//
// When D1/H4 are split, the engine uses the non-neutral HTF direction as the
// candidate reversal direction. The actual reversal still must pass the existing
// HTF tap -> liquidity sweep -> displacement -> CISD/MSS -> fresh M5 gates.
// Continuations continue to require D1/H4 alignment in ictCorrectiveGate.js.
// ---------------------------------------------------------------------------
let engine = fs.readFileSync(ENGINE, 'utf8');
const oldDirectionBlock = `  const htfAligned = dailyTfBias !== 'neutral' && dailyTfBias === h4TfBias;\n  const studiedDirection = marketMakerContext?.studyReady === true\n    ? sign(marketMakerContext?.cycle?.direction)\n    : null;\n  // Continuation direction comes only from D1/H4 agreement. When they are split,\n  // the current-day study may supply direction only for the stricter reversal path.\n  const want = htfAligned ? dailyTfBias : studiedDirection;\n  const dir = toLS(want);\n  const reversalStudyDirection = !htfAligned && Boolean(want) && marketMakerContext?.studyReady === true;\n  const analysisDirection = dir === 'long' ? 'buy' : dir === 'short' ? 'sell' : 'none';`;
const newDirectionBlock = `  const htfAligned = dailyTfBias !== 'neutral' && dailyTfBias === h4TfBias;\n  // D1/H4 alignment owns continuation direction. When the HTFs are split, use\n  // the available non-neutral HTF direction as the candidate reversal direction.\n  // Reversal authorization still requires the full market-maker sequence below.\n  const reversalDirection = dailyTfBias !== 'neutral'\n    ? dailyTfBias\n    : h4TfBias !== 'neutral' ? h4TfBias : null;\n  const want = htfAligned ? dailyTfBias : reversalDirection;\n  const dir = toLS(want);\n  const reversalContext = !htfAligned && Boolean(want);\n  const analysisDirection = dir === 'long' ? 'buy' : dir === 'short' ? 'sell' : 'none';`;
if (!engine.includes(newDirectionBlock)) {
  if (!engine.includes(oldDirectionBlock)) throw new Error('[ICT_REVERSAL_DIRECTION] direction gate anchor missing');
  engine = engine.replace(oldDirectionBlock, newDirectionBlock);
}

engine = engine.replace(
  '    studiedReversalDirection: reversalStudyDirection,',
  '    reversalContext,',
);

const oldHardGate = `  const hardFails = [];\n  if (!htfAligned && !reversalStudyDirection) {\n    hardFails.push('Hard gate: Daily and 4H are not aligned for continuation and no current-day studied reversal direction is available.');\n  }\n  if (want && !kz.inKillzone) hardFails.push('Hard gate: no active ICT killzone/session.');`;
const newHardGate = `  const hardFails = [];\n  if (want && !kz.inKillzone) hardFails.push('Hard gate: no active ICT killzone/session.');`;
if (!engine.includes(newHardGate)) {
  if (!engine.includes(oldHardGate)) throw new Error('[ICT_REVERSAL_DIRECTION] hard-gate anchor missing');
  engine = engine.replace(oldHardGate, newHardGate);
}

engine = engine.replace(
  '    reversalContext: reversalStudyDirection,\n    killzoneQuality:',
  '    reversalContext,\n    killzoneQuality:',
);

for (const marker of [
  'const reversalDirection = dailyTfBias !== \'neutral\'',
  'const reversalContext = !htfAligned && Boolean(want);',
  'reversalContext,',
]) {
  if (!engine.includes(marker)) throw new Error(`[ICT_REVERSAL_DIRECTION] engine verification missing ${marker}`);
}
if (engine.includes('no current-day studied reversal direction is available')) {
  throw new Error('[ICT_REVERSAL_DIRECTION] studied reversal direction hard gate remains');
}
if (engine.includes('studiedReversalDirection: reversalStudyDirection')) {
  throw new Error('[ICT_REVERSAL_DIRECTION] stale studied-reversal observation remains');
}
fs.writeFileSync(ENGINE, engine, 'utf8');

let marketMaker = fs.readFileSync(MARKET_MAKER, 'utf8');
const oldMarketMakerGate = `  const studiedReversalDirection = observation?.studiedReversalDirection === true;\n  if (!direction || (observation?.htfAligned !== true && !studiedReversalDirection)) {\n    return {\n      cycle: context?.cycle ?? null,\n      changed: false,\n      entryAuthorization: {\n        ...baseAuthorization,\n        reason: 'No valid continuation alignment or current-day studied reversal direction is available.',\n      },\n    };\n  }`;
const newMarketMakerGate = `  if (!direction) {\n    return {\n      cycle: context?.cycle ?? null,\n      changed: false,\n      entryAuthorization: {\n        ...baseAuthorization,\n        reason: 'No valid ICT trade direction is available.',\n      },\n    };\n  }`;
if (!marketMaker.includes(newMarketMakerGate)) {
  if (!marketMaker.includes(oldMarketMakerGate)) throw new Error('[ICT_REVERSAL_DIRECTION] market-maker gate anchor missing');
  marketMaker = marketMaker.replace(oldMarketMakerGate, newMarketMakerGate);
}
if (marketMaker.includes('current-day studied reversal direction is available')) {
  throw new Error('[ICT_REVERSAL_DIRECTION] market-maker studied reversal direction gate remains');
}
fs.writeFileSync(MARKET_MAKER, marketMaker, 'utf8');

console.log('[ICT_REVERSAL_DIRECTION] removed studied-reversal-direction qualification; preserved 02:00 study and all downstream reversal/continuation gates.');