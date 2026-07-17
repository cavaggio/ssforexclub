#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path):
    return (ROOT / path).read_text(encoding='utf-8')


required = {
    'server/primaryTimeframeAlignment.js': [
        "export const HARD_ALIGNMENT_TIMEFRAMES = ['daily', 'h4']",
        "export const PRIMARY_ALIGNMENT_TIMEFRAMES = ['daily', 'h4', 'm15']",
        "export const CONTEXT_ALIGNMENT_TIMEFRAMES = ['m30', 'm5']",
        'const score = dailyH4Aligned ? (m15Aligned ? 100 : 67)',
        'const passed = dailyH4Aligned && score >= PRIMARY_ALIGNMENT_MIN_SCORE',
    ],
    'server/v3Engine.js': [
        'derivePrimaryTimeframes({ dailyCandles, h4Candles, m15Candles })',
        'analyzeMarketStructure({ pair, h1Candles, h4Candles, m15Candles })',
        'safeFib({ direction, h1Candles, currentPrice: price, pair })',
    ],
    'server/marketStructureEngine.js': [
        'analyzeMarketStructure({',
        'h1Candles = []',
        "const useH1 = Array.isArray(h1Candles) && h1Candles.length >= 20",
        "const timeframeUsed = useH1 ? 'H1'",
    ],
    'server/primaryTimeframeAlignment.test.js': [
        'Daily and H4 aligned score exactly 67',
        'Daily H4 and M15 aligned scores 100',
        'H1 never changes the alignment score',
    ],
    'server/marketStructureEngine.test.js': [
        'market structure uses H1 when H1 candles are available',
        'M15 is the first fallback when H1 is unavailable',
    ],
}

forbidden = {
    'server/primaryTimeframeAlignment.js': [
        "FIB_ONLY_TIMEFRAMES",
        'H1 is reserved for Fibonacci',
    ],
    'server/v3Engine.js': [
        'analyzeMarketStructure({ pair, h4Candles, m15Candles })',
        'h1Candles: m15Candles',
        'H1 cannot influence structure direction',
    ],
    'server/marketStructureEngine.js': [
        'H1 is intentionally excluded',
        'h1Used: false,\n    reasons,',
    ],
    'server/v3DashboardScan.js': [
        "h1: 'fib_only'",
        "h1Trend: 'fib_only'",
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
    raise RuntimeError('V3 alignment-role enforcement incomplete:\n- ' + '\n- '.join(failures))

print('V3 alignment roles verified: Daily/H4=67, Daily/H4/M15=100; H1 excluded from alignment but available to structure and Fib.')
