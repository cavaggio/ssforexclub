#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
AUTO = ROOT / 'server' / 'v3AutoTrade.js'
ICT_EXECUTION = ROOT / 'server' / 'ictExecution.js'

body = AUTO.read_text(encoding='utf-8')
body = body.replace(
    "scanV3IndependentMarket(). It does not call oandaScanner, consume legacy\n"
    " * qualified/rejected arrays, inherit legacy direction, blend legacy confidence,\n"
    " * or read a shared legacy retrace-watch registry.",
    "scanV3IndependentMarket(). It consumes no foreign-engine scanner output,\n"
    " * direction, confidence, qualification arrays, or watch registries.",
)
body = body.replace(
    "'legacyScannerUsed=false sharedRetraceWatchUsed=false'",
    "'foreignStrategyInputs=false'",
)
AUTO.write_text(body, encoding='utf-8')

# ICT owns its native recompute and execution gates. The retired June 23 decision
# engine was an unused import here and must not remain as a runtime dependency.
ict = ICT_EXECUTION.read_text(encoding='utf-8')
ict = ict.replace("import { evaluateTradeCandidate } from './tradeDecisionEngine.js';\n", '')
ICT_EXECUTION.write_text(ict, encoding='utf-8')

print('V3 markers normalized and retired decision imports removed.')
