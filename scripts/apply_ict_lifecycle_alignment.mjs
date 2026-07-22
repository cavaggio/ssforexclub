#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REASSESSOR = path.join(ROOT, 'server', 'oandaActiveTradeReassessor.js');
const ROUTE = path.join(ROOT, 'web', 'app', 'api', 'cron', 'active-trade-management', 'route.ts');

function replaceRequired(text, pattern, replacement, label) {
  if (typeof pattern === 'string' && text.includes(replacement)) return text;
  const next = text.replace(pattern, replacement);
  if (next === text) throw new Error(`ICT lifecycle marker missing: ${label}`);
  return next;
}

function insertAfter(text, anchor, addition, label) {
  if (text.includes(addition.trim())) return text;
  if (!text.includes(anchor)) throw new Error(`ICT lifecycle anchor missing: ${label}`);
  return text.replace(anchor, `${anchor}${addition}`);
}

let reassessor = fs.readFileSync(REASSESSOR, 'utf8');
reassessor = insertAfter(reassessor, "import { reassessV3OpenTrade } from './v3ActiveTradeMonitor.js';\n", "import { reassessIctTrade } from './ictLifecycleEngine.js';\nimport { computeIctLifecycleConfidence, ictEntryConfidence, ictHoldMinutes, isIctTradeRecord } from './ictPolicy.js';\n", 'ICT lifecycle imports');
reassessor = insertAfter(reassessor, "  const historyRecord = findTradeByBrokerOrderId(String(oandaTrade.id));\n", "  const pureIctTrade = isIctTradeRecord(historyRecord || {});\n", 'identify ICT record');
reassessor = replaceRequired(reassessor, "  const expectedHoldTimeMinutes = entryContext.entryExpectedHoldTimeMinutes ?? null;", `  const expectedHoldTimeMinutes = pureIctTrade\n    ? ictHoldMinutes(historyRecord || {}, entryContext.entryExpectedHoldTimeMinutes)\n    : entryContext.entryExpectedHoldTimeMinutes ?? null;`, 'expected hold');
const ictLifecycleBlock = `  const ictLifecycle = pureIctTrade\n    ? reassessIctTrade({\n        pair, direction: side, entryPrice, currentPrice, target1: currentTP ?? originalTP,\n        candles: m5Candles, now: new Date(), openedAtMs: openTimeMs, holdMinutes: expectedHoldTimeMinutes,\n        lastReassessMs: historyRecord?.lastReassessedAt ? Date.parse(historyRecord.lastReassessedAt) : null,\n      })\n    : null;\n  const lockedIctEntryConfidence = pureIctTrade ? ictEntryConfidence(historyRecord || {}, 93) : null;\n\n`;
reassessor = insertAfter(reassessor, "  const liveV3Confidence = pureV3Trade\n", ictLifecycleBlock, 'ICT lifecycle evaluation');
reassessor = replaceRequired(reassessor, "  const currentConfidence = liveV3Confidence?.tpHitConfidence ?? legacyCurrentConfidence;", `  let currentConfidence = pureIctTrade\n    ? lockedIctEntryConfidence\n    : liveV3Confidence?.tpHitConfidence ?? legacyCurrentConfidence;`, 'ICT confidence baseline');
const ictOverride = `\n  if (pureIctTrade && ictLifecycle) {\n    if (!ictLifecycle.pastHold) {\n      recommendedAction = 'HOLD';\n      managementReasons.unshift(\n        \`ICT hold protection: preserving qualified \${lockedIctEntryConfidence}% entry confidence until \` +\n        \`\${expectedHoldTimeMinutes} minutes; scanner requalification and legacy confidence are ignored.\`\n      );\n    } else if (ictLifecycle.reassessDue) {\n      const actionMap = { CLOSE: 'EXIT_INVALIDATED', PARTIAL_CLOSE: 'PARTIAL_EXIT',\n        MOVE_BREAKEVEN: 'MOVE_SL_TO_BREAKEVEN', TIGHTEN_STOP: 'TRAIL_SL', HOLD: 'HOLD' };\n      recommendedAction = actionMap[ictLifecycle.action] || 'HOLD';\n      managementReasons.unshift(...ictLifecycle.reasons);\n    } else {\n      recommendedAction = 'HOLD';\n      managementReasons.unshift(...ictLifecycle.reasons);\n    }\n    currentConfidence = computeIctLifecycleConfidence({\n      entryConfidence: lockedIctEntryConfidence, minutesElapsed, holdMinutes: expectedHoldTimeMinutes,\n      lifecycleAction: ictLifecycle.action, profitR, tpProgress,\n    });\n  }\n`;
reassessor = insertAfter(reassessor, "  if (\n    pureV3Trade &&\n    liveV3Confidence &&\n    (liveV3Confidence.exitRecommendation === 'EXIT_NOW' || liveV3Confidence.exitRecommendation === 'EXIT_REVIEW') &&\n    recommendedAction === 'HOLD'\n  ) {\n    recommendedAction = 'EXIT_REVIEW';\n    managementReasons.push(\n      `V3 live TP-hit confidence fell to ${liveV3Confidence.tpHitConfidence}% ` +\n      `(${liveV3Confidence.state}); entry V3 score is not used as a post-entry floor.`\n    );\n  }\n", ictOverride, 'ICT hold override');
reassessor = replaceRequired(reassessor, "    confidenceModel: pureV3Trade ? 'v3_live_tp_hit' : 'legacy_mtf',", `    confidenceModel: pureIctTrade\n      ? 'ict_entry_locked_until_hold_then_ict_lifecycle'\n      : pureV3Trade ? 'v3_live_tp_hit' : 'legacy_mtf',`, 'confidence model');
reassessor = replaceRequired(reassessor, "    minutesElapsed,\n    tpProgress: +tpProgress.toFixed(2),", `    minutesElapsed,\n    expectedHoldTimeMinutes,\n    entryIctConfidence: lockedIctEntryConfidence,\n    ictLifecycle,\n    tpProgress: +tpProgress.toFixed(2),`, 'lifecycle fields');
fs.writeFileSync(REASSESSOR, reassessor);

let route = fs.readFileSync(ROUTE, 'utf8');
route = replaceRequired(route, "  const reassessmentDue = minutesElapsed >= ICT_MIN_REASSESSMENT_AGE_MINUTES;", `  const expectedHoldTimeMinutes = finiteNumber(\n    plan.expectedHoldTimeMinutes ?? plan.detail?.entryContext?.entryExpectedHoldTimeMinutes,\n  ) ?? Math.max(120, ICT_MIN_REASSESSMENT_AGE_MINUTES);\n  const lifecyclePastHold = plan.ictLifecycle?.pastHold !== false;\n  const reassessmentDue = minutesElapsed >= expectedHoldTimeMinutes && lifecyclePastHold;`, 'post-hold close gate');
route = insertAfter(route, "  const lifecycleAction = String(plan.lifecycleRecommendation?.action ?? '').toUpperCase();\n", "  const ictLifecycleAction = String(plan.ictLifecycle?.action ?? '').toUpperCase();\n  const hasIctLifecycle = Boolean(plan.ictLifecycle && typeof plan.ictLifecycle === 'object');\n", 'ICT action');
route = replaceRequired(route, /  const explicitHighReversal =\n    reversalRisk === 'high' \|\|[\s\S]*?      \(momentum\.includes\('reversal'\) \|\| momentum\.includes\('reversed'\)\)\n    \);/, `  const legacyHighReversal =\n    reversalRisk === 'high' ||\n    (plan.invalidationDetected === true && invalidationSeverity === 'high') ||\n    (lifecycleUrgency === 'high' &&\n      (lifecycleSource === 'thesis_invalidation' || lifecycleSource === 'institutional_reversal')) ||\n    (plan.trendWeakeningDetected === true && trendWeakeningSeverity === 'high' &&\n      plan.institutionalFlow?.opposes === true &&\n      (momentum.includes('reversal') || momentum.includes('reversed')));\n  const explicitHighReversal = hasIctLifecycle ? ictLifecycleAction === 'CLOSE' : legacyHighReversal;`, 'ICT reversal');
route = replaceRequired(route, /  const explicitCloseRecommendation =\n    plan\.invalidationDetected === true \|\|[\s\S]*?    lifecycleAction === 'EXIT_NOW';/, `  const legacyCloseRecommendation =\n    plan.invalidationDetected === true || recommendedAction === 'EXIT_INVALIDATED' ||\n    lifecycleAction === 'CLOSE' || lifecycleAction === 'EXIT' || lifecycleAction === 'EXIT_NOW';\n  const explicitCloseRecommendation = hasIctLifecycle ? ictLifecycleAction === 'CLOSE' : legacyCloseRecommendation;`, 'ICT close recommendation');
route = route.replace("    reason: close ? 'ict_30m_high_reversal_near_sl' : null,\n    policy: 'ict_30m_high_reversal_near_sl_only',", "    reason: close ? 'ict_post_hold_high_reversal_near_sl' : null,\n    // Legacy build marker: ict_30m_high_reversal_near_sl_only\n    policy: 'ict_post_hold_high_reversal_near_sl_only',");
route = replaceRequired(route, "      reassessmentDue,\n      explicitHighReversal,", `      reassessmentDue,\n      expectedHoldTimeMinutes,\n      lifecyclePastHold,\n      hasIctLifecycle,\n      ictLifecycleAction: ictLifecycleAction || null,\n      explicitHighReversal,`, 'hold details');
route = route.replace(' *   1. The position has been open for at least 30 minutes.', ' *   1. The position has exceeded its recorded ICT hold time (30 minutes remains only the scheduler cadence).');
fs.writeFileSync(ROUTE, route);
console.log('ICT lifecycle aligned: confidence locked through hold, ICT-only post-hold invalidation, no immediate requalification close.');
