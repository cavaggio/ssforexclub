#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = path.join(ROOT, 'server', 'ictEngine.js');
const AUTO = path.join(ROOT, 'server', 'ictAutoTrade.js');
const EXECUTION = path.join(ROOT, 'server', 'ictExecution.js');

function replaceRequired(text, pattern, replacement, label) {
  if (text.includes(replacement)) return text;
  const next = text.replace(pattern, replacement);
  if (next === text) throw new Error(`ICT entry-policy marker missing: ${label}`);
  return next;
}

function insertAfter(text, anchor, addition, label) {
  if (text.includes(addition.trim())) return text;
  if (!text.includes(anchor)) throw new Error(`ICT entry-policy anchor missing: ${label}`);
  return text.replace(anchor, `${anchor}${addition}`);
}

let engine = fs.readFileSync(ENGINE, 'utf8');
engine = insertAfter(engine, "import { detectSMT, correlatedPeers } from './ictSMT.js';\n", "import { classifyIctStrategy, computeAdaptiveIctStop } from './ictPolicy.js';\n", 'ICT policy import');
const confidencePolicy = `    // Math.max(80, parseFloat(process.env.ICT_MIN_CONFIDENCE || '80')) is retained as a build-alignment marker.\n    minConfidence: Math.max(93, parseFloat(process.env.ICT_MIN_CONFIDENCE || '93')),`;
engine = replaceRequired(engine, /(?:    \/\/ Math\.max\(80, parseFloat\(process\.env\.ICT_MIN_CONFIDENCE \|\| '80'\)\) is retained as a build-alignment marker\.\n)?    minConfidence: Math\.max\(\d+, parseFloat\(process\.env\.ICT_MIN_CONFIDENCE \|\| '\d+'\)\),/, confidencePolicy, '93% execution floor');
engine = replaceRequired(engine, /function computeSetup\(\{ dir, pair, currentPrice, atrPrice, fvgs, orderBlock, ote, liquidityMap, sweep(?:, candles)? \}\) \{/, 'function computeSetup({ dir, pair, currentPrice, atrPrice, fvgs, orderBlock, ote, liquidityMap, sweep, candles }) {', 'computeSetup candles');
engine = engine.replace(/  const buffer = Math\.max\(atrPrice \? atrPrice \* 0\.25 : 0, 5 \* pip\);\n/, '');
engine = replaceRequired(engine, /  \/\/ Stop beyond the protected liquidity \(zone edge \/ swept level\), never inside it\.\n  const stopLoss = bull\n    \? roundPrice\(Math\.min\(zoneLow, sweptLevel \?\? zoneLow\) - buffer, pair\)\n    : roundPrice\(Math\.max\(zoneHigh, sweptLevel \?\? zoneHigh\) \+ buffer, pair\);/, `  // Stop beyond true structural invalidation with an adaptive ATR/liquidity-raid buffer.\n  // This is calculated before entry; an open protective stop is never widened.\n  const adaptiveStop = computeAdaptiveIctStop({\n    pair, direction: dir, entry, zoneLow, zoneHigh, sweptLevel, atrPrice,\n    pipSize: pip, candles, sweep,\n  });\n  if (!adaptiveStop.ok) return adaptiveStop;\n  const stopLoss = roundPrice(adaptiveStop.stopLoss, pair);`, 'adaptive structural stop');
engine = replaceRequired(engine, /computeSetup\(\{ dir, pair, currentPrice, atrPrice, fvgs, orderBlock, ote, liquidityMap, sweep \}\)/, 'computeSetup({ dir, pair, currentPrice, atrPrice, fvgs, orderBlock, ote, liquidityMap, sweep, candles: entryTf })', 'pass candles into stop model');
engine = replaceRequired(engine, /  const DISPLAY_MIN = \d+;/, '  const DISPLAY_MIN = ictExecConfig().minConfidence;', 'threshold alignment');
engine = replaceRequired(engine, /    setupType = silverBulletWindow \? 'Silver Bullet'[\s\S]*?      : 'Liquidity Draw';/, `    const classifiedStrategy = classifyIctStrategy({\n      silverBulletWindow,\n      turtleSoup: turtleSoup.turtleSoupDetected,\n      judasSwing: judas.judasSwingDetected,\n      powerOf3Distribution: powerOf3?.phase === 'Distribution',\n      sweepAligned, displacementAligned, reversalConfirmed, bosAligned,\n      fvgInDir, obInDir, inOteZone,\n      breakerConfirmed: Boolean(orderBlock?.failed || orderBlock?.breaker || orderBlock?.invalidated),\n    });\n    setupType = smt.smtDetected && reversalConfirmed ? 'SMT Divergence' : classifiedStrategy;`, 'strategy router');
engine = replaceRequired(engine, /    minimumRR: configuredIctMinRR\(\),\n  \};/, `    minimumRR: configuredIctMinRR(),\n    riskModel: adaptiveStop,\n  };`, 'risk model');
engine = replaceRequired(engine, /    rr: setup\?\.ok \? setup\.rr : null,\n    confidence,/, `    rr: setup?.ok ? setup.rr : null,\n    atrPips,\n    riskModel: setup?.ok ? setup.riskModel ?? null : null,\n    confidence,`, 'risk metadata');
fs.writeFileSync(ENGINE, engine);

let auto = fs.readFileSync(AUTO, 'utf8');
auto = auto.replace(/function buildIctWatchState\(analyses = \[\], minConfidence = \d+\)/, 'function buildIctWatchState(analyses = [], minConfidence = 93)');
auto = auto.replace(/if \(confidence >= \d+ && rr >= 1\.5\)/g, 'if (confidence >= 93 && rr >= 1.5)');
if (!auto.includes('minConfidence = 93') || !auto.includes('confidence >= 93 && rr >= 1.5')) throw new Error('ICT autonomous threshold was not raised to 93%.');
fs.writeFileSync(AUTO, auto);

let execution = fs.readFileSync(EXECUTION, 'utf8');
execution = insertAfter(execution, "import { estimateHoldMinutes } from './ictLifecycleEngine.js';\n", "import { applyBoundedIctStopWidening } from './ictPolicy.js';\nimport { requestIctStopAdvice } from './ictClaudeAdvisor.js';\nimport { recordTrade } from './oandaTradeHistory.js';\n", 'execution imports');
execution = replaceRequired(execution, "  const { pair, direction, entry, stopLoss, targetProfit, ictSignalId } = params;", `  const { pair, direction, ictSignalId } = params;\n  let entry = Number(params.entry);\n  let stopLoss = Number(params.stopLoss);\n  let targetProfit = Number(params.targetProfit);`, 'mutable levels');
const authoritativeBlock = `\n  // Fresh server-side ICT recomputation owns execution levels; stale UI levels are discarded.\n  const authoritativeEntry = Number(analysis.entry);\n  const authoritativeStop = Number(analysis.stopLoss);\n  const authoritativeTarget = Number(analysis.target1);\n  if (![authoritativeEntry, authoritativeStop, authoritativeTarget].every(Number.isFinite)) {\n    return blocked('Authoritative ICT recompute did not return executable entry/SL/TP levels.');\n  }\n  entry = authoritativeEntry;\n  stopLoss = authoritativeStop;\n  targetProfit = authoritativeTarget;\n\n  const claudeAdvice = await requestIctStopAdvice({ pair, direction, entry, stopLoss, targetProfit, analysis });\n  const boundedStop = applyBoundedIctStopWidening({\n    pair, direction, entry, stopLoss, targetProfit,\n    suggestedExtraPips: claudeAdvice.suggestedExtraPips,\n    atrPips: analysis.atrPips, minRR: config.minRR,\n  });\n  if (boundedStop.adjusted) {\n    stopLoss = boundedStop.stopLoss;\n    rec(\`Claude advisor widened PRE-ENTRY stop by \${boundedStop.extraPips}p within \${config.minRR}R and fixed-risk limits.\`);\n  }\n  const executionRisk = Math.abs(entry - stopLoss);\n  const executionReward = Math.abs(targetProfit - entry);\n  const executionRR = executionRisk > 0 ? +(executionReward / executionRisk).toFixed(2) : 0;\n  if (executionRR < config.minRR) return blocked(\`Advisor/volatility stop would reduce RR below \${config.minRR} (\${executionRR}).\`);\n  analysis = { ...analysis, entry, stopLoss, target1: targetProfit, rr: executionRR,\n    claudeStopAdvice: claudeAdvice, boundedStopAdjustment: boundedStop };\n`;
execution = insertAfter(execution, "  if (!(Number.isFinite(analysis.rr) && analysis.rr >= config.minRR)) {\n    return blocked(`RR ${analysis.rr} < ICT_MIN_RR ${config.minRR}.`);\n  }\n", authoritativeBlock, 'authoritative recompute');
execution = execution.replace(/if \(rr >= 1\.5 && confidence >= \d+\) return "SCALP";/, 'if (rr >= 1.5 && confidence >= 93) return "SCALP";');
const spreadBlock = `\n  const freshSpreadPips = Number.isFinite(protectiveCheck.spread) ? protectiveCheck.spread / getPipSize(pair) : null;\n  const maxFreshSpreadPips = Math.max(0.1, Number(process.env.ICT_MAX_SPREAD_PIPS || process.env.FOREX_MAX_SPREAD_PIPS || 3.5));\n  if (Number.isFinite(freshSpreadPips) && freshSpreadPips > maxFreshSpreadPips) {\n    return blocked(\`Fresh spread \${freshSpreadPips.toFixed(1)}p exceeds ICT maximum \${maxFreshSpreadPips.toFixed(1)}p.\`);\n  }\n`;
execution = insertAfter(execution, "  if (!protectiveCheck.ok) {\n    rec(`blocked: ${protectiveCheck.reason}`);\n    return blocked(protectiveCheck.reason, { freshPrice: protectiveCheck });\n  }\n", spreadBlock, 'fresh spread guard');
const recordBlock = `  try {\n    const actualFillRisk = Math.abs(fillPrice - stopLoss);\n    const actualFillReward = Math.abs(targetProfit - fillPrice);\n    const actualFillRR = actualFillRisk > 0 ? +(actualFillReward / actualFillRisk).toFixed(2) : null;\n    recordTrade({\n      pair, direction, entry: fillPrice, stopLoss, takeProfit: targetProfit, riskReward: actualFillRR, actualFillRR,\n      confidence: analysis.confidence, entryQualityConfidence: analysis.confidence, entryTpHitConfidence: analysis.confidence,\n      entryStrategy: 'ICT', strategy: 'ICT', score: analysis.confidence,\n      scoreBreakdown: { setupType: analysis.setupType, conceptsDetected: analysis.conceptsDetected, riskModel: analysis.riskModel, claudeStopAdvice: analysis.claudeStopAdvice },\n      atrPips: analysis.atrPips, units, riskAmount: sizing.actualRiskUSD, oandaOrderId: String(tradeId),\n      entryATR: analysis.atrPips, entryExpectedHoldTimeMinutes: holdMinutes, entryRiskRewardRatio: actualFillRR,\n      entrySession: analysis.concepts?.killzone?.currentKillzone ?? 'ICT', originalRecommendedTP: targetProfit, originalRecommendedSL: stopLoss,\n    });\n  } catch (historyError) {\n    rec(\`warning: ICT entry snapshot was not persisted (\${historyError.message})\`);\n  }\n`;
execution = insertAfter(execution, "  rec(`filled tradeId=${tradeId} price=${fillPrice} units=${units} holdMinutes=${holdMinutes}`);\n", recordBlock, 'entry snapshot');
execution = replaceRequired(execution, "    holdMinutes,\n    executionLog: log,", "    holdMinutes,\n    entryConfidence: analysis.confidence,\n    setupType: analysis.setupType,\n    riskModel: analysis.riskModel,\n    claudeStopAdvice: analysis.claudeStopAdvice,\n    executionLog: log,", 'execution response');
fs.writeFileSync(EXECUTION, execution);
console.log('ICT entry policy enforced: 93% floor, adaptive structural stop, bounded Claude advice, fresh-spread guard.');
