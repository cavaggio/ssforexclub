#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
AUTO = ROOT / 'server' / 'v3AutoTrade.js'

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

print('V3 isolation markers normalized before enforcement.')
