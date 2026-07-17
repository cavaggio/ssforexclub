#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INDEX = ROOT / 'server' / 'index.js'
TRADE = ROOT / 'server' / 'oandaTrade.js'


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if new in text:
        return text
    if old not in text:
        raise RuntimeError(f'PPR integration marker missing: {label}')
    return text.replace(old, new, 1)


# Route the shared internal endpoint to exactly one of ICT, V3, or PPR.
index = INDEX.read_text(encoding='utf-8')
index = replace_once(
    index,
    "  const engine = String(req.body?.engine || 'ict').toLowerCase() === 'v3' ? 'v3' : 'ict';",
    "  const requestedEngine = String(req.body?.engine || 'ict').toLowerCase();\n"
    "  const engine = ['ict', 'v3', 'ppr'].includes(requestedEngine) ? requestedEngine : 'ict';",
    'server/index.js engine normalization',
)
index = index.replace(
    '  //   path (ICT or V3) — never both. Requires environment=live (per-user creds).',
    '  //   path (ICT, V3, or PPR) — never more than one. Requires a per-user executable environment.',
)
for marker in [
    "['ict', 'v3', 'ppr'].includes(requestedEngine)",
    'runAutoForUser({ client, engine, runId:',
]:
    if marker not in index:
        raise RuntimeError(f'PPR index integration incomplete: missing {marker}')
INDEX.write_text(index, encoding='utf-8')


# Make the shared OANDA function a strategy-neutral broker/risk transport for
# PPR. PPR keeps universal broker safety while bypassing legacy/V3/ICT strategy
# gates and lifecycle mutation.
trade = TRADE.read_text(encoding='utf-8')
trade = replace_once(
    trade,
    "import { evaluateUniversalEntryPolicy, setupFingerprint } from './executionPolicy.js';",
    "import { evaluateUniversalEntryPolicy, setupFingerprint } from './executionPolicy.js';\n"
    "import { evaluatePprExecutionPolicy, isPprExecutionSignal, pprSetupFingerprint } from './pprExecutionPolicy.js';",
    'PPR policy import',
)

# Upstream V3 generators may rebuild part of the execution header while
# preserving PPR lines from a prior pass. Remove every generated header line and
# insert one canonical set immediately before executableGeometry on every run.
for declaration in [
    "  const pureV3Execution = isPureV3ExecutionSignal(signal);\n",
    "  const purePprExecution = isPprExecutionSignal(signal);\n",
    "  const independentStrategyExecution = pureV3Execution || purePprExecution;\n",
    "  let executableEntry = Number(entry);\n",
]:
    trade = trade.replace(declaration, '')
trade = replace_once(
    trade,
    "  let executableGeometry = null;",
    "  const pureV3Execution = isPureV3ExecutionSignal(signal);\n"
    "  const purePprExecution = isPprExecutionSignal(signal);\n"
    "  const independentStrategyExecution = pureV3Execution || purePprExecution;\n"
    "  let executableEntry = Number(entry);\n"
    "  let executableGeometry = null;",
    'PPR execution classification',
)

# Legacy trend/flow/timing logic must not influence PPR.
trade = replace_once(
    trade,
    "  if (!pureV3Execution) {\n    const signalTrend     = signal.trend;",
    "  if (!independentStrategyExecution) {\n    const signalTrend     = signal.trend;",
    'legacy EMA/MTF bypass',
)
trade = trade.replace('      !pureV3Execution &&\n      flow?.detected &&', '      !independentStrategyExecution &&\n      flow?.detected &&')
trade = trade.replace("    if (!pureV3Execution && ENTRY_TIMING_STRICT && timing?.status === 'too_early') {", "    if (!independentStrategyExecution && ENTRY_TIMING_STRICT && timing?.status === 'too_early') {")
trade = trade.replace("    if (!pureV3Execution && ENTRY_TIMING_STRICT && timing?.status === 'wait_for_retest') {", "    if (!independentStrategyExecution && ENTRY_TIMING_STRICT && timing?.status === 'wait_for_retest') {")
trade = trade.replace("    if (!pureV3Execution && timing && timing.status !== 'valid_entry') {", "    if (!independentStrategyExecution && timing && timing.status !== 'valid_entry') {")

trade = replace_once(
    trade,
    "  if (pureV3Execution) {\n    console.log(`[V3_PURE] ${pair} ${direction} — skipping legacy EMA/MTF gate; V3 liquidity/structure/session owns qualification.`);\n  }",
    "  if (pureV3Execution) {\n"
    "    console.log(`[V3_PURE] ${pair} ${direction} — skipping legacy EMA/MTF gate; V3 owns qualification.`);\n"
    "  }\n"
    "  if (purePprExecution) {\n"
    "    console.log(`[PPR_PURE] ${pair} ${direction} — skipping legacy/V3/ICT strategy gates; PPR owns qualification.`);\n"
    "  }",
    'PPR isolation log',
)

trade = replace_once(
    trade,
    "  const universalPolicy = evaluateUniversalEntryPolicy(signal);\n  if (!universalPolicy.allowed) return blocked(`Universal entry policy: ${universalPolicy.reasons.join('; ')}`);",
    "  const strategyEntryPolicy = purePprExecution\n"
    "    ? evaluatePprExecutionPolicy(signal, { minRR: MIN_EXECUTABLE_RR })\n"
    "    : evaluateUniversalEntryPolicy(signal);\n"
    "  if (!strategyEntryPolicy.allowed) {\n"
    "    return blocked(`${purePprExecution ? 'PPR' : 'Universal'} entry policy: ${strategyEntryPolicy.reasons.join('; ')}`);\n"
    "  }",
    'PPR entry policy selection',
)

# Preserve PPR's own swing-pool target and stop geometry instead of applying the
# platform scalp TP/hold cap. All shared R:R, risk, margin, spread, duplicate and
# drawdown checks still run below this point.
old_lifecycle = """  const scalpLifecycle = normalizeScalpLifecycle({
    pair,
    direction,
    entryPrice: executableEntry,
    atrPips: signal.atrPips ?? signal.momentum?.atrPips,
    lifecycle: {
      allowed: true,
      sl: {
        ...(signal.lifecycle?.sl || {}),
        stopLossPips: slPips,
        stopLossPrice: slPriceFromLifecycle,
      },
      tp: {
        ...(signal.lifecycle?.tp || {}),
        allowed: true,
        takeProfitPips: tpPips,
        takeProfitPrice: tpPriceFromLifecycle,
      },
      hold: signal.lifecycle?.hold || null,
    },
  });
"""
new_lifecycle = """  const scalpLifecycle = purePprExecution
    ? {
        allowed: true,
        lifecycle: {
          ...signal.lifecycle,
          allowed: true,
          sl: {
            ...(signal.lifecycle?.sl || {}),
            stopLossPips: slPips,
            stopLossPrice: slPriceFromLifecycle,
          },
          tp: {
            ...(signal.lifecycle?.tp || {}),
            allowed: true,
            takeProfitPips: tpPips,
            takeProfitPrice: tpPriceFromLifecycle,
          },
        },
      }
    : normalizeScalpLifecycle({
        pair,
        direction,
        entryPrice: executableEntry,
        atrPips: signal.atrPips ?? signal.momentum?.atrPips,
        lifecycle: {
          allowed: true,
          sl: {
            ...(signal.lifecycle?.sl || {}),
            stopLossPips: slPips,
            stopLossPrice: slPriceFromLifecycle,
          },
          tp: {
            ...(signal.lifecycle?.tp || {}),
            allowed: true,
            takeProfitPips: tpPips,
            takeProfitPrice: tpPriceFromLifecycle,
          },
          hold: signal.lifecycle?.hold || null,
        },
      });
"""
trade = replace_once(trade, old_lifecycle, new_lifecycle, 'PPR lifecycle preservation')

trade = replace_once(
    trade,
    "  const setupKey = setupFingerprint(signal, accountId);",
    "  const setupKey = purePprExecution\n"
    "    ? pprSetupFingerprint(signal, accountId)\n"
    "    : setupFingerprint(signal, accountId);",
    'PPR setup fingerprint',
)

# If the dormant high-edge helper is later reconnected, it must not impose V3
# probability/trigger fields on PPR.
for old in [
    "const highEdge = highEdgeAutoAiGate(signal, sizing);",
    "const highEdgeGate = highEdgeAutoAiGate(signal, sizing);",
]:
    if old in trade:
        name = 'highEdge' if old.startswith('const highEdge =') else 'highEdgeGate'
        trade = trade.replace(
            old,
            f"const {name} = purePprExecution ? {{ allowed: true, reasons: [], metrics: {{ engine: 'ppr' }} }} : highEdgeAutoAiGate(signal, sizing);",
            1,
        )

required_trade = [
    "isPprExecutionSignal(signal)",
    'independentStrategyExecution = pureV3Execution || purePprExecution',
    "evaluatePprExecutionPolicy(signal, { minRR: MIN_EXECUTABLE_RR })",
    'pprSetupFingerprint(signal, accountId)',
    'const scalpLifecycle = purePprExecution',
]
for marker in required_trade:
    if marker not in trade:
        raise RuntimeError(f'PPR trade integration incomplete: missing {marker}')
TRADE.write_text(trade, encoding='utf-8')

print('Independent PPR engine integration applied.')
