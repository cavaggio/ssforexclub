import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  buildIctImpulseLifecycle,
  ICT_IMPULSE_LIFECYCLE_FAILURE,
} from '../server/ictImpulseLifecycle.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const H1_MOMENTUM = path.join(ROOT, 'server', 'ictH1Momentum.js');
const ICT_EXECUTION = path.join(ROOT, 'server', 'ictExecution.js');
const TRADE_CONTEXT = path.join(ROOT, 'server', 'ictTradeContext.js');
const PATCH_MARKER = 'ICT_IMPULSE_LIFECYCLE_PATCH_V1';

function insertAfter(source, anchor, addition, label) {
  if (source.includes(addition.trim())) return source;
  if (!source.includes(anchor)) throw new Error(`[ICT_IMPULSE_LIFECYCLE] missing ${label}`);
  return source.replace(anchor, () => `${anchor}${addition}`);
}

function replaceOnce(source, before, after, label) {
  if (source.includes(after)) return source;
  if (!source.includes(before)) throw new Error(`[ICT_IMPULSE_LIFECYCLE] missing ${label}`);
  return source.replace(before, () => after);
}

// H1 impulse identity and entry-context persistence are committed source. The
// runtime generator touches only ictExecution.js, which is already an allowed
// generated-source target in the repository policy pipeline.
let execution = fs.readFileSync(ICT_EXECUTION, 'utf8');
execution = insertAfter(
  execution,
  `import { buildIctTradeEntryContext } from './ictTradeContext.js';\n`,
  `import { buildIctImpulseLifecycle, ICT_IMPULSE_LIFECYCLE_FAILURE } from './ictImpulseLifecycle.js';\n`,
  'impulse lifecycle execution import',
);

execution = replaceOnce(
  execution,
  `    const executionSignal = { ...analysis, pair, direction, entry, stopLoss, takeProfit: targetProfit };\n    const entryCycleKey = ictEntryCycleFingerprint({ analysis, accountId, pair, direction });\n    const entryCycleReservation = await reserveExecution({\n      fingerprint: entryCycleKey,\n      accountId,\n      pair,\n      direction,\n      expiresMinutes: 180,\n    });\n    if (!entryCycleReservation.allowed) {\n      return blocked(\n        \`ICT entry-cycle guard rejected ${'${entryAuthorization.cycleId}'}: ${'${entryCycleReservation.reason}'}. \` +\n        'A closed trade cannot reopen from the same H1 transition or M5 continuation breakout.',\n      );\n    }\n`,
  `    // ${PATCH_MARKER}: keep directional correctness separate from entry freshness.\n    // The existing ICT gates still decide whether the setup is valid; this only\n    // prevents a second AUTO continuation fill from consuming the same H1 impulse.\n    const impulseLifecycle = autoAi\n      ? buildIctImpulseLifecycle({ analysis, accountId, pair, direction })\n      : { applies: false };\n    if (impulseLifecycle.applies) {\n      analysis = {\n        ...analysis,\n        impulseLifecycle: {\n          ...impulseLifecycle,\n          stateAtEntry: 'fresh',\n          entryFresh: true,\n        },\n      };\n    }\n    const executionSignal = { ...analysis, pair, direction, entry, stopLoss, takeProfit: targetProfit };\n    const entryCycleKey = impulseLifecycle.applies\n      ? impulseLifecycle.fingerprint\n      : ictEntryCycleFingerprint({ analysis, accountId, pair, direction });\n    const entryCycleReservation = await reserveExecution({\n      fingerprint: entryCycleKey,\n      accountId,\n      pair,\n      direction,\n      // A new H1 impulse produces a new fingerprint, so this long TTL cannot\n      // block a legitimate later transition. It only outlives the first trade.\n      expiresMinutes: impulseLifecycle.applies ? 720 : 180,\n    });\n    if (!entryCycleReservation.allowed) {\n      if (impulseLifecycle.applies) {\n        const consumedLifecycle = {\n          ...impulseLifecycle,\n          state: 'consumed',\n          stateAtEntry: 'consumed',\n          entryFresh: false,\n        };\n        return blocked(\n          \`ICT impulse lifecycle rejected ${'${pair}'} ${'${direction}'}: the directional thesis may remain valid, but this H1 impulse was already consumed by an earlier autonomous continuation entry. Wait for a new H1 impulse/transition.\`,\n          {\n            failureCode: ICT_IMPULSE_LIFECYCLE_FAILURE,\n            impulseLifecycle: consumedLifecycle,\n          },\n        );\n      }\n      return blocked(\n        \`ICT entry-cycle guard rejected ${'${entryAuthorization.cycleId}'}: ${'${entryCycleReservation.reason}'}. \` +\n        'A closed trade cannot reopen from the same H1 transition or M5 continuation breakout.',\n      );\n    }\n`,
  'autonomous continuation impulse reservation',
);
fs.writeFileSync(ICT_EXECUTION, execution);

// Build-time behavioral contracts. These do not modify strategy source; they
// verify same-impulse reuse is blocked while a new H1 impulse remains eligible.
const sameImpulseA = buildIctImpulseLifecycle({
  accountId: 'A1', pair: 'GBP_USD', direction: 'long',
  analysis: {
    correctiveGate: { family: 'continuation', passed: true },
    h1Momentum: { impulseId: 'bullish:2026-08-20T14:00:00.000Z' },
    entryAuthorization: { mode: 'm5_continuation_breakout', cycleId: 'm5-A' },
  },
});
const sameImpulseB = buildIctImpulseLifecycle({
  accountId: 'A1', pair: 'GBP_USD', direction: 'long',
  analysis: {
    correctiveGate: { family: 'continuation', passed: true },
    h1Momentum: { impulseId: 'bullish:2026-08-20T14:00:00.000Z' },
    entryAuthorization: { mode: 'm5_continuation_recovery', cycleId: 'm5-B' },
  },
});
const newImpulse = buildIctImpulseLifecycle({
  accountId: 'A1', pair: 'GBP_USD', direction: 'long',
  analysis: {
    correctiveGate: { family: 'continuation', passed: true },
    h1Momentum: { impulseId: 'bullish:2026-08-20T16:00:00.000Z' },
    entryAuthorization: { mode: 'm5_continuation_breakout', cycleId: 'm5-C' },
  },
});
const reversal = buildIctImpulseLifecycle({
  accountId: 'A1', pair: 'GBP_USD', direction: 'long',
  analysis: {
    correctiveGate: { family: 'reversal', passed: true },
    entryAuthorization: { mode: 'initial_reversal_mss', cycleId: 'reversal-A' },
  },
});
assert.equal(sameImpulseA.applies, true);
assert.equal(sameImpulseA.fingerprint, sameImpulseB.fingerprint, 'different M5 triggers must share one H1 impulse reservation');
assert.notEqual(sameImpulseA.fingerprint, newImpulse.fingerprint, 'a genuinely new H1 impulse must become eligible');
assert.equal(reversal.applies, false, 'reversal authorization must remain unchanged');
assert.equal(ICT_IMPULSE_LIFECYCLE_FAILURE, 'IMPULSE_ALREADY_CONSUMED');

const h1Module = await import(`${pathToFileURL(H1_MOMENTUM).href}?impulse=${Date.now()}`);
const candle = (time, open, close) => ({
  time, open, close, high: Math.max(open, close) + 0.0002,
  low: Math.min(open, close) - 0.0002, complete: true,
});
const firstRun = h1Module.classifyIctH1Momentum({
  bias: 'bullish',
  h1Candles: [
    candle('2026-08-20T13:00:00.000Z', 1.3650, 1.3640),
    candle('2026-08-20T14:00:00.000Z', 1.3640, 1.3650),
    candle('2026-08-20T15:00:00.000Z', 1.3650, 1.3660),
  ],
});
const extendedRun = h1Module.classifyIctH1Momentum({
  bias: 'bullish',
  h1Candles: [
    candle('2026-08-20T13:00:00.000Z', 1.3650, 1.3640),
    candle('2026-08-20T14:00:00.000Z', 1.3640, 1.3650),
    candle('2026-08-20T15:00:00.000Z', 1.3650, 1.3660),
    candle('2026-08-20T16:00:00.000Z', 1.3660, 1.3670),
  ],
});
assert.equal(firstRun.impulseId, 'bullish:2026-08-20T14:00:00.000Z');
assert.equal(firstRun.impulseId, extendedRun.impulseId, 'same-direction H1 continuation must keep the same impulse identity');

for (const [file, required] of [
  [H1_MOMENTUM, [PATCH_MARKER, 'impulseAnchorAt,', 'impulseId,']],
  [ICT_EXECUTION, [PATCH_MARKER, 'buildIctImpulseLifecycle', 'failureCode: ICT_IMPULSE_LIFECYCLE_FAILURE', 'expiresMinutes: impulseLifecycle.applies ? 720 : 180']],
  [TRADE_CONTEXT, ['impulseLifecycle: analysis.impulseLifecycle || null']],
]) {
  const source = fs.readFileSync(file, 'utf8');
  for (const marker of required) {
    if (!source.includes(marker)) throw new Error(`[ICT_IMPULSE_LIFECYCLE] verification missing ${marker} in ${file}`);
  }
}

console.log('ICT impulse lifecycle applied: one autonomous continuation entry per stable H1 impulse; new H1 impulse restores eligibility.');
