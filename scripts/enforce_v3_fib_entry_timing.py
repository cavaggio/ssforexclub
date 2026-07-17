#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path):
    return (ROOT / path).read_text(encoding='utf-8')


def write(path, text):
    (ROOT / path).write_text(text, encoding='utf-8')


def replace_once(path, old, new, label):
    text = read(path)
    if new in text:
        return
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{label}: expected one anchor, found {count}')
    write(path, text.replace(old, new, 1))


# ---------------------------------------------------------------------------
# One authoritative, pair-specific H1 Fibonacci entry window.
# ---------------------------------------------------------------------------
replace_once(
    'server/oandaFibonacci.js',
    "const MIN_IMPULSE_ATR_MULTIPLE = 1.2;\nconst SWING_PIVOT_LOOKBACK = 3;",
    "export const FIB_ENTRY_RETRACE_MIN = 0.382;\nexport const FIB_ENTRY_RETRACE_MAX = 0.68;\n\nconst MIN_IMPULSE_ATR_MULTIPLE = 1.2;\nconst SWING_PIVOT_LOOKBACK = 3;",
    'Fib entry policy constants',
)
replace_once(
    'server/oandaFibonacci.js',
    "    level618: swingHigh - range * 0.618,\n    level786: swingHigh - range * 0.786,",
    "    level618: swingHigh - range * 0.618,\n    level680: swingHigh - range * FIB_ENTRY_RETRACE_MAX,\n    level786: swingHigh - range * 0.786,",
    'bullish 68 percent level',
)
replace_once(
    'server/oandaFibonacci.js',
    "    level618: swingLow + range * 0.618,\n    level786: swingLow + range * 0.786,",
    "    level618: swingLow + range * 0.618,\n    level680: swingLow + range * FIB_ENTRY_RETRACE_MAX,\n    level786: swingLow + range * 0.786,",
    'bearish 68 percent level',
)
replace_once(
    'server/oandaFibonacci.js',
    "  const entryZone = direction === 'long'\n    ? { lower: levels.level786, upper: levels.level382 }\n    : { lower: levels.level382, upper: levels.level786 };\n\n  const insideZone =\n    currentPrice >= Math.min(entryZone.lower, entryZone.upper) &&\n    currentPrice <= Math.max(entryZone.lower, entryZone.upper);",
    "  const entryZone = direction === 'long'\n    ? { lower: levels.level680, upper: levels.level382 }\n    : { lower: levels.level382, upper: levels.level680 };\n\n  const insideZone = Number.isFinite(pctRetraced) &&\n    pctRetraced >= FIB_ENTRY_RETRACE_MIN &&\n    pctRetraced <= FIB_ENTRY_RETRACE_MAX;",
    'pair-specific Fib entry zone',
)
replace_once(
    'server/oandaFibonacci.js',
    "    } else if (pctRetraced < 0.382) {\n      entryZoneStatus = 'too_early';\n      reason = `Price only ${(pctRetraced * 100).toFixed(0)}% retraced (< 38.2%) — not yet inside H1 entry zone`;\n    } else {\n      entryZoneStatus = 'extended';\n      reason = 'Price > 78.6% retraced — deep H1 retracement, treat as near-invalidation rather than entry';",
    "    } else if (pctRetraced < FIB_ENTRY_RETRACE_MIN) {\n      entryZoneStatus = 'too_early';\n      reason = `Price only ${(pctRetraced * 100).toFixed(0)}% retraced (< ${(FIB_ENTRY_RETRACE_MIN * 100).toFixed(1)}%) — waiting for the pair-specific H1 entry zone`;\n    } else {\n      entryZoneStatus = 'extended';\n      reason = `Price ${(pctRetraced * 100).toFixed(0)}% retraced (> ${(FIB_ENTRY_RETRACE_MAX * 100).toFixed(0)}%) — beyond the permitted H1 entry window`;",
    'bullish Fib timing thresholds',
)
replace_once(
    'server/oandaFibonacci.js',
    "  } else if (pctRetraced < 0.382) {\n    entryZoneStatus = 'too_early';\n    reason = `Price only ${(pctRetraced * 100).toFixed(0)}% retraced (< 38.2%) — not yet inside H1 entry zone`;\n  } else {\n    entryZoneStatus = 'extended';\n    reason = 'Price > 78.6% retraced — deep H1 retracement, treat as near-invalidation rather than entry';",
    "  } else if (pctRetraced < FIB_ENTRY_RETRACE_MIN) {\n    entryZoneStatus = 'too_early';\n    reason = `Price only ${(pctRetraced * 100).toFixed(0)}% retraced (< ${(FIB_ENTRY_RETRACE_MIN * 100).toFixed(1)}%) — waiting for the pair-specific H1 entry zone`;\n  } else {\n    entryZoneStatus = 'extended';\n    reason = `Price ${(pctRetraced * 100).toFixed(0)}% retraced (> ${(FIB_ENTRY_RETRACE_MAX * 100).toFixed(0)}%) — beyond the permitted H1 entry window`;",
    'bearish Fib timing thresholds',
)
replace_once(
    'server/oandaFibonacci.js',
    "      level618: round(levels.level618),\n      level786: round(levels.level786),",
    "      level618: round(levels.level618),\n      level680: round(levels.level680),\n      level786: round(levels.level786),",
    'Fib level response',
)
replace_once(
    'server/oandaFibonacci.js',
    "    entryZoneStatus,\n    pctRetraced: Number.isFinite(pctRetraced) ? +pctRetraced.toFixed(3) : null,\n    breakoutConfirmed,",
    "    entryZoneStatus,\n    entryZoneMinPct: FIB_ENTRY_RETRACE_MIN,\n    entryZoneMaxPct: FIB_ENTRY_RETRACE_MAX,\n    entryEligible: insideZone,\n    pctRetraced: Number.isFinite(pctRetraced) ? +pctRetraced.toFixed(3) : null,\n    breakoutConfirmed,",
    'Fib eligibility response',
)

# ---------------------------------------------------------------------------
# Entry timing uses that pair's current Fib state, never origin-distance globals.
# ---------------------------------------------------------------------------
replace_once(
    'server/v3EntryContract.js',
    "import { evaluatePrimaryTimeframeAlignment } from './primaryTimeframeAlignment.js';",
    "import { evaluatePrimaryTimeframeAlignment } from './primaryTimeframeAlignment.js';\nimport { FIB_ENTRY_RETRACE_MIN, FIB_ENTRY_RETRACE_MAX } from './oandaFibonacci.js';",
    'entry contract Fib policy import',
)
replace_once(
    'server/v3EntryContract.js',
    "  const fibStatus = String(v3?.fib?.entryZoneStatus || signal?.fibonacci?.entryZoneStatus || '').toLowerCase();\n  const entryDistance = numberOrNull(v3.entryDistanceFromOriginPct ?? signal.entryDistanceFromOriginPct);\n  const maxEntryDistance = Number(process.env.V3_QUALITY_MAX_ENTRY_DISTANCE || 0.55);",
    "  const fib = v3?.fib || signal?.fibonacci || null;\n  const fibStatus = String(fib?.entryZoneStatus || '').toLowerCase();\n  const fibRetracement = numberOrNull(fib?.pctRetraced);\n  const fibEntryMin = numberOrNull(fib?.entryZoneMinPct) ?? FIB_ENTRY_RETRACE_MIN;\n  const fibEntryMax = numberOrNull(fib?.entryZoneMaxPct) ?? FIB_ENTRY_RETRACE_MAX;\n  const fibApplicable = Boolean(\n    fib?.enabled === true &&\n    fib?.timeframeUsed &&\n    fibRetracement !== null\n  );\n  const fibInEntryWindow = Boolean(\n    fibApplicable &&\n    fibRetracement >= fibEntryMin &&\n    fibRetracement <= fibEntryMax\n  );",
    'dynamic pair Fib timing inputs',
)
replace_once(
    'server/v3EntryContract.js',
    "  } else if (fibStatus === 'invalidated') {\n    status = 'invalidated';\n    reason = 'price invalidated the V3 impulse origin';\n  } else if (\n    fibStatus === 'extended' ||\n    (entryDistance !== null && Number.isFinite(maxEntryDistance) && entryDistance > maxEntryDistance)\n  ) {\n    status = 'late_entry';\n    reason = 'price has moved beyond the permitted V3 entry distance';\n  } else if (pendingSweep || fibStatus === 'too_early') {\n    status = 'too_early';\n    reason = pendingSweep\n      ? 'liquidity sweep is still pending confirmation'\n      : 'price has not reached the permitted entry area';",
    "  } else if (fibStatus === 'invalidated' || (fibApplicable && fibRetracement > 1)) {\n    status = 'invalidated';\n    reason = 'price invalidated the pair-specific H1 impulse origin';\n  } else if (fibApplicable && fibRetracement < fibEntryMin) {\n    status = 'too_early';\n    reason = `pair-specific H1 retracement ${(fibRetracement * 100).toFixed(1)}% is below ${(fibEntryMin * 100).toFixed(1)}%; waiting for the valid entry zone`;\n  } else if (fibApplicable && fibRetracement > fibEntryMax) {\n    status = 'late_entry';\n    reason = `pair-specific H1 retracement ${(fibRetracement * 100).toFixed(1)}% is beyond ${(fibEntryMax * 100).toFixed(1)}%; entry window has passed`;\n  } else if (!fibApplicable && fibStatus === 'too_early') {\n    status = 'too_early';\n    reason = 'H1 Fibonacci analysis is waiting for the valid entry zone';\n  } else if (pendingSweep) {\n    status = 'too_early';\n    reason = 'liquidity sweep is still pending confirmation';",
    'Fib-authoritative timing sequence',
)
replace_once(
    'server/v3EntryContract.js',
    "  } else if (\n    retest.confirmed ||\n    reversal.alignedSweep ||\n    bos ||\n    (choch && reversal.sequenceConfirmed)\n  ) {\n    status = 'valid_entry';\n    reason = 'Daily/H4 alignment and Stage 2 entry sequence are confirmed';",
    "  } else if (\n    (!fibApplicable || fibInEntryWindow) &&\n    (\n      retest.confirmed ||\n      reversal.alignedSweep ||\n      bos ||\n      (choch && reversal.sequenceConfirmed)\n    )\n  ) {\n    status = 'valid_entry';\n    reason = fibApplicable\n      ? `pair-specific H1 retracement ${(fibRetracement * 100).toFixed(1)}% is inside ${(fibEntryMin * 100).toFixed(1)}%–${(fibEntryMax * 100).toFixed(1)}% and the Stage 2 trigger is confirmed`\n      : 'Daily/H4 alignment and Stage 2 entry sequence are confirmed';",
    'Fib-gated valid entry',
)
replace_once(
    'server/v3EntryContract.js',
    "    reversalSequenceConfirmed: reversal.sequenceConfirmed,\n    checkedAt: new Date().toISOString(),",
    "    reversalSequenceConfirmed: reversal.sequenceConfirmed,\n    fibApplicable,\n    fibRetracementPct: fibRetracement === null ? null : Number((fibRetracement * 100).toFixed(1)),\n    fibEntryMinPct: Number((fibEntryMin * 100).toFixed(1)),\n    fibEntryMaxPct: Number((fibEntryMax * 100).toFixed(1)),\n    fibInEntryWindow,\n    timingSource: fibApplicable ? 'pair_h1_fibonacci_and_stage2_trigger' : 'pair_stage2_trigger',\n    checkedAt: new Date().toISOString(),",
    'entry timing diagnostics',
)

# ---------------------------------------------------------------------------
# Stage 2 remains on hot watch while the pair is too early or waiting for retest.
# Late/invalidated states remain blocked.
# ---------------------------------------------------------------------------
replace_once(
    'server/v3QualityConfirmation.js',
    "  const minSupports = envNumber('V3_QUALITY_TRIGGER_MIN_SUPPORTS', 1);\n  const reasons = [...entryContract.reasons];",
    "  const minSupports = envNumber('V3_QUALITY_TRIGGER_MIN_SUPPORTS', 1);\n  const timingStatus = String(entryContract?.entryTiming?.status || '').toLowerCase();\n  const waitingForValidEntry = timingStatus === 'too_early' || timingStatus === 'wait_for_retest';\n  const terminalEntryBlock = timingStatus === 'late_entry' || timingStatus === 'invalidated';\n  const reasons = [...entryContract.reasons];",
    'Stage 2 timing state inputs',
)
replace_once(
    'server/v3QualityConfirmation.js',
    "    state: reasons.length === 0 ? 'ready' : (sweep.pending || primaryTriggers.length === 0 ? 'watch' : 'blocked'),",
    "    state: reasons.length === 0\n      ? 'ready'\n      : (!terminalEntryBlock && (waitingForValidEntry || sweep.pending || primaryTriggers.length === 0) ? 'watch' : 'blocked'),",
    'Stage 2 dynamic watch state',
)
replace_once(
    'server/v3QualityConfirmation.js',
    "      minSupports,\n    },",
    "      minSupports,\n      waitingForValidEntry,\n      terminalEntryBlock,\n      fibRetracementPct: entryContract?.entryTiming?.fibRetracementPct ?? null,\n      fibEntryMinPct: entryContract?.entryTiming?.fibEntryMinPct ?? null,\n      fibEntryMaxPct: entryContract?.entryTiming?.fibEntryMaxPct ?? null,\n      fibInEntryWindow: entryContract?.entryTiming?.fibInEntryWindow === true,\n    },",
    'Stage 2 Fib metrics',
)

# Stage 2 watch candidates are hot-trigger pairs and are rechecked at the hot cadence.
replace_once(
    'server/v3AutoTrade.js',
    "function buildIndependentWatchState(scan, qualified = []) {\n  const hotPairs = new Set(qualified.map(pairOf).filter(Boolean));\n  const nearQualifiedPairs = new Set(\n    (Array.isArray(scan?.watchCandidates) ? scan.watchCandidates : [])\n      .map(pairOf)\n      .filter(Boolean),\n  );",
    "function buildIndependentWatchState(scan, qualified = []) {\n  const stage2WatchPairs = (Array.isArray(scan?.watchCandidates) ? scan.watchCandidates : [])\n    .map(pairOf)\n    .filter(Boolean);\n  const hotPairs = new Set([\n    ...qualified.map(pairOf).filter(Boolean),\n    ...stage2WatchPairs,\n  ]);\n  const nearQualifiedPairs = new Set();",
    'Stage 2 hot watch cadence',
)

required = {
    'server/oandaFibonacci.js': [
        'export const FIB_ENTRY_RETRACE_MIN = 0.382',
        'export const FIB_ENTRY_RETRACE_MAX = 0.68',
        'level680',
        'entryEligible: insideZone',
    ],
    'server/v3EntryContract.js': [
        'pair-specific H1 retracement',
        "timingSource: fibApplicable ? 'pair_h1_fibonacci_and_stage2_trigger'",
        'fibInEntryWindow',
    ],
    'server/v3QualityConfirmation.js': [
        'waitingForValidEntry',
        'terminalEntryBlock',
        'fibInEntryWindow',
    ],
    'server/v3AutoTrade.js': [
        'stage2WatchPairs',
        'const nearQualifiedPairs = new Set()',
    ],
}
forbidden = {
    'server/v3EntryContract.js': [
        'V3_QUALITY_MAX_ENTRY_DISTANCE',
        'price has moved beyond the permitted V3 entry distance',
    ],
}

failures = []
for relative, markers in required.items():
    body = read(relative)
    for marker in markers:
        if marker not in body:
            failures.append(f'{relative}: missing {marker}')
for relative, markers in forbidden.items():
    body = read(relative)
    for marker in markers:
        if marker in body:
            failures.append(f'{relative}: forbidden marker remains {marker}')
if failures:
    raise RuntimeError('V3 Fib entry timing enforcement incomplete:\n- ' + '\n- '.join(failures))

print('V3 Fib entry timing verified: pair-specific H1 38.2%-68% window, Stage 2 hot watch, no static origin-distance gate.')
