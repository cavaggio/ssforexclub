#!/usr/bin/env python3
"""Enforce PPR's 75% execution floor, practice/live readiness, and scan counts.

The repository regenerates server source during pretest/prebuild/prestart. This
idempotent pass runs after the PPR generator so deployment source cannot restore
the former 85% PPR threshold or accidentally make practice execution depend on
live-only safety flags.
"""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT / "server" / "pprEngine.js"
TRADE = ROOT / "server" / "oandaTrade.js"


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if new in text:
        return text
    if old not in text:
        raise RuntimeError(f"PPR execution alignment marker missing: {label}")
    return text.replace(old, new, 1)


engine = ENGINE.read_text(encoding="utf-8")
engine = engine.replace(
    "minConfidence: Math.max(0, Math.min(100, numberEnv('PPR_MIN_CONFIDENCE', 85))),",
    "minConfidence: 75,",
)
engine = engine.replace(
    "minConfidence: Math.max(80, Math.min(100, numberEnv('PPR_MIN_CONFIDENCE', 80))),",
    "minConfidence: 75,",
)

previous_readiness_helper = """
export function pprExecutionReadiness({ client = null, config = pprConfig() } = {}) {
  const environment = String(client?.environment || 'practice').toLowerCase();
  const autoTradeEnabled = String(process.env.FOREX_AUTO_TRADE_ENABLED || 'false').toLowerCase() === 'true';
  const liveExecutionAllowed = String(process.env.FOREX_ALLOW_LIVE_EXECUTION || 'false').toLowerCase() === 'true';
  const blockers = [];
  if (!autoTradeEnabled) blockers.push('FOREX_AUTO_TRADE_ENABLED is not true on Railway');
  if (environment !== 'live') blockers.push(`active broker environment is ${environment}, not live`);
  if (environment === 'live' && !liveExecutionAllowed) blockers.push('FOREX_ALLOW_LIVE_EXECUTION is not true on Railway');
  return {
    environment,
    autoTradeEnabled,
    liveExecutionAllowed,
    orderSubmissionReady: autoTradeEnabled && (environment !== 'live' || liveExecutionAllowed),
    liveReady: environment === 'live' && autoTradeEnabled && liveExecutionAllowed,
    minConfidence: config.minConfidence,
    minRR: config.minRR,
    blockers,
  };
}

export function pprScanCounts({ qualified = [], watchCandidates = [], rejected = [] } = {}) {
  const qualifiedCount = Array.isArray(qualified) ? qualified.length : 0;
  const watchCount = Array.isArray(watchCandidates) ? watchCandidates.length : 0;
  const rejectedCount = Array.isArray(rejected) ? rejected.length : 0;
  const accountedFor = qualifiedCount + watchCount + rejectedCount;
  return { qualifiedCount, watchCount, rejectedCount, accountedFor };
}

"""

readiness_helper = """
export function pprExecutionReadiness({ client = null, config = pprConfig() } = {}) {
  const environment = String(client?.environment || 'practice').toLowerCase();
  const autoTradeEnabled = String(process.env.FOREX_AUTO_TRADE_ENABLED || 'false').toLowerCase() === 'true';
  const liveExecutionAllowed = String(process.env.FOREX_ALLOW_LIVE_EXECUTION || 'false').toLowerCase() === 'true';
  const practiceEnvironment = environment === 'practice' || environment === 'paper';
  const liveEnvironment = environment === 'live';
  const practiceReady = practiceEnvironment && autoTradeEnabled;
  const liveReady = liveEnvironment && autoTradeEnabled && liveExecutionAllowed;
  const orderSubmissionReady = practiceReady || liveReady;
  const blockers = [];
  if (!autoTradeEnabled) blockers.push('FOREX_AUTO_TRADE_ENABLED is not true on Railway');
  if (!practiceEnvironment && !liveEnvironment) blockers.push(`unsupported broker environment: ${environment}`);
  if (liveEnvironment && !liveExecutionAllowed) blockers.push('FOREX_ALLOW_LIVE_EXECUTION is not true on Railway');
  return {
    environment,
    executionMode: practiceEnvironment ? 'practice' : liveEnvironment ? 'live' : 'unsupported',
    autoTradeEnabled,
    liveExecutionAllowed,
    practiceReady,
    liveReady,
    orderSubmissionReady,
    minConfidence: config.minConfidence,
    minRR: config.minRR,
    blockers,
  };
}

export function pprScanCounts({ qualified = [], watchCandidates = [], rejected = [] } = {}) {
  const qualifiedCount = Array.isArray(qualified) ? qualified.length : 0;
  const watchCount = Array.isArray(watchCandidates) ? watchCandidates.length : 0;
  const rejectedCount = Array.isArray(rejected) ? rejected.length : 0;
  const accountedFor = qualifiedCount + watchCount + rejectedCount;
  return { qualifiedCount, watchCount, rejectedCount, accountedFor };
}

"""

if previous_readiness_helper in engine:
    engine = engine.replace(previous_readiness_helper, readiness_helper, 1)
else:
    engine = replace_once(
        engine,
        "export function getPprWatchlist() {",
        readiness_helper + "export function getPprWatchlist() {",
        "PPR readiness/count helpers",
    )

base_return = """  return {
    engine: 'ppr',
    architecture: 'independent_ppr_raw_market_data',
    watchlist: allowedWatchlist,
    qualified,
    watchCandidates,
    rejected,
    meta: {
      pairsScanned: requested.length,
      generatedAt: new Date().toISOString(),
      managementCutoffEt: '10:00',
      afterCutoff: 'manual_only',
      newsPolicy: 'not_configured',
    },
  };"""
previous_generated_return = """  const counts = pprScanCounts({ qualified, watchCandidates, rejected });
  const config = pprConfig();
  const executionReadiness = pprExecutionReadiness({ client, config });
  const countInvariantOk = requested.length === counts.accountedFor;
  log(
    `scan complete scanned=${requested.length} qualified=${counts.qualifiedCount} ` +
    `watching=${counts.watchCount} rejected=${counts.rejectedCount} ` +
    `accounted=${counts.accountedFor} countInvariantOk=${countInvariantOk} ` +
    `liveReady=${executionReadiness.liveReady}`,
  );

  return {
    engine: 'ppr',
    architecture: 'independent_ppr_raw_market_data',
    watchlist: allowedWatchlist,
    qualified,
    watchCandidates,
    rejected,
    meta: {
      pairsScanned: requested.length,
      qualifiedCount: counts.qualifiedCount,
      watchCount: counts.watchCount,
      rejectedCount: counts.rejectedCount,
      accountedFor: counts.accountedFor,
      countInvariantOk,
      minConfidence: config.minConfidence,
      minRR: config.minRR,
      executionReadiness,
      generatedAt: new Date().toISOString(),
      managementCutoffEt: '10:00',
      afterCutoff: 'manual_only',
      newsPolicy: 'not_configured',
    },
  };"""
new_return = """  const counts = pprScanCounts({ qualified, watchCandidates, rejected });
  const config = pprConfig();
  const executionReadiness = pprExecutionReadiness({ client, config });
  const countInvariantOk = requested.length === counts.accountedFor;
  log(
    `scan complete scanned=${requested.length} qualified=${counts.qualifiedCount} ` +
    `watching=${counts.watchCount} rejected=${counts.rejectedCount} ` +
    `accounted=${counts.accountedFor} countInvariantOk=${countInvariantOk} ` +
    `executionMode=${executionReadiness.executionMode} executionReady=${executionReadiness.orderSubmissionReady}`,
  );

  return {
    engine: 'ppr',
    architecture: 'independent_ppr_raw_market_data',
    watchlist: allowedWatchlist,
    qualified,
    watchCandidates,
    rejected,
    meta: {
      pairsScanned: requested.length,
      qualifiedCount: counts.qualifiedCount,
      watchCount: counts.watchCount,
      rejectedCount: counts.rejectedCount,
      accountedFor: counts.accountedFor,
      countInvariantOk,
      minConfidence: config.minConfidence,
      minRR: config.minRR,
      executionReadiness,
      generatedAt: new Date().toISOString(),
      managementCutoffEt: '10:00',
      afterCutoff: 'manual_only',
      newsPolicy: 'not_configured',
    },
  };"""

if previous_generated_return in engine:
    engine = engine.replace(previous_generated_return, new_return, 1)
else:
    engine = replace_once(engine, base_return, new_return, "PPR scan count/readiness metadata")

for marker in [
    "minConfidence: 75",
    "export function pprExecutionReadiness",
    "practiceReady",
    "orderSubmissionReady",
    "export function pprScanCounts",
    "qualifiedCount: counts.qualifiedCount",
    "countInvariantOk",
    "executionMode=${executionReadiness.executionMode}",
]:
    if marker not in engine:
        raise RuntimeError(f"PPR engine execution alignment incomplete: missing {marker}")

ENGINE.write_text(engine, encoding="utf-8")


trade = TRADE.read_text(encoding="utf-8")
trade = replace_once(
    trade,
    "  checkAutoExecutionConfidence,\n} from './riskManager.js';",
    "  checkAutoExecutionConfidence,\n  riskConfig,\n} from './riskManager.js';",
    "risk config import",
)

floor_helper = """
export function pprExecutionConfidenceFloor() {
  return HARD_SCALP_CONFIDENCE_FLOOR;
}
"""
trade = replace_once(
    trade,
    "const MIN_EXECUTABLE_RR     = parseFloat(process.env.FOREX_MIN_EXECUTABLE_RR || '1.5');",
    "const MIN_EXECUTABLE_RR     = parseFloat(process.env.FOREX_MIN_EXECUTABLE_RR || '1.5');\n" + floor_helper,
    "PPR execution confidence helper",
)
trade = replace_once(
    trade,
    "  const executionConfidenceFloor = MIN_CONFIDENCE;",
    "  const executionConfidenceFloor = purePprExecution ? pprExecutionConfidenceFloor() : MIN_CONFIDENCE;",
    "strategy-specific confidence floor",
)
trade = replace_once(
    trade,
    "    const confCheck = checkAutoExecutionConfidence(confidence);\n    if (!confCheck.passed) return blocked(confCheck.reason);",
    "    const confCheck = purePprExecution\n      ? checkAutoExecutionConfidence(confidence, {\n          ...riskConfig(),\n          autoExecutionMinConfidence: executionConfidenceFloor,\n        })\n      : checkAutoExecutionConfidence(confidence);\n    if (!confCheck.passed) return blocked(confCheck.reason);",
    "PPR Auto AI confidence override",
)
trade = replace_once(
    trade,
    "    minConfidence: MIN_CONFIDENCE,",
    "    minConfidence: executionConfidenceFloor,",
    "dynamic sizing PPR confidence floor",
)

for marker in [
    "export function pprExecutionConfidenceFloor",
    "purePprExecution ? pprExecutionConfidenceFloor() : MIN_CONFIDENCE",
    "autoExecutionMinConfidence: executionConfidenceFloor",
    "minConfidence: executionConfidenceFloor",
]:
    if marker not in trade:
        raise RuntimeError(f"Shared executor PPR alignment incomplete: missing {marker}")

TRADE.write_text(trade, encoding="utf-8")
print("PPR execution aligned: 75% floor, practice/live readiness, and exact scan accounting")
