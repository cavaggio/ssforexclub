#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path, old, new, label):
    target = ROOT / path
    text = target.read_text(encoding='utf-8')
    if new in text:
        return
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{label}: expected one anchor, found {count}')
    target.write_text(text.replace(old, new, 1), encoding='utf-8')


# Actual H1 candle data is reserved for detectFibSetup. Existing liquidity and
# session helpers still accept a historically named h1Candles argument, so V3
# supplies M15 data to that intraday slot rather than H1 data.
replace_once(
    'server/v3Engine.js',
    "  const liquidity = analyzeLiquidity({ pair, dailyCandles, h4Candles, h1Candles, m15Candles, currentPrice: price, atrPips });",
    "  const liquidity = analyzeLiquidity({ pair, dailyCandles, h4Candles, h1Candles: m15Candles, m15Candles, currentPrice: price, atrPips });",
    'V3 liquidity must not consume H1 candles',
)
replace_once(
    'server/v3Engine.js',
    "  const session = analyzeSession({ now, h1Candles, atrPips, atrHistorical });",
    "  const session = analyzeSession({ now, h1Candles: m15Candles, atrPips, atrHistorical });",
    'V3 session must not consume H1 candles',
)

# The dashboard must not present H1 as a directional or structure timeframe.
replace_once(
    'server/v3DashboardScan.js',
    "      h1: structureTrend,",
    "      h1: 'fib_only',",
    'dashboard H1 alignment role',
)
replace_once(
    'server/v3DashboardScan.js',
    "    h1Trend: structureTrend,",
    "    h1Trend: 'fib_only',",
    'dashboard H1 structure role',
)

# Expand the compatibility types so the UI can state the role explicitly rather
# than displaying a fabricated bullish/bearish/flat H1 trend.
replace_once(
    'web/types/forex.ts',
    "  h1Trend: 'bullish' | 'bearish' | 'neutral';",
    "  h1Trend: 'bullish' | 'bearish' | 'neutral' | 'fib_only';",
    'StructureAnalysis H1 fib-only type',
)
replace_once(
    'web/types/forex.ts',
    "    h1:    'bullish' | 'bearish' | 'neutral';",
    "    h1:    'bullish' | 'bearish' | 'neutral' | 'fib_only';",
    'AlignmentResult H1 fib-only type',
)

# Render role labels cleanly in the existing timeframe pill.
replace_once(
    'web/components/scanner-status-card.tsx',
    "        {trend === 'bullish' ? '▲' : trend === 'bearish' ? '▼' : '·'} {trend === 'neutral' ? 'flat' : trend}",
    "        {trend === 'bullish' ? '▲' : trend === 'bearish' ? '▼' : '·'} {trend === 'neutral' ? 'flat' : trend.replace(/_/g, ' ')}",
    'timeframe role display formatting',
)

required = {
    'server/primaryTimeframeAlignment.js': [
        "export const HARD_ALIGNMENT_TIMEFRAMES = ['daily', 'h4']",
        "export const FIB_ONLY_TIMEFRAMES = ['h1']",
        "const score = dailyH4Aligned ? (m15Aligned ? 100 : 67)",
    ],
    'server/v3Engine.js': [
        'h1Candles: m15Candles',
        'safeFib({ direction, h1Candles, currentPrice: price, pair })',
        'analyzeMarketStructure({ pair, h4Candles, m15Candles })',
    ],
    'server/marketStructureEngine.js': [
        'analyzeMarketStructure({ pair, h4Candles = [], m15Candles = [] }',
        "timeframeUsed = useM15 ? 'M15'",
        'h1Used: false',
    ],
    'server/v3DashboardScan.js': ["h1: 'fib_only'", "h1Trend: 'fib_only'"],
    'web/types/forex.ts': ["'neutral' | 'fib_only'"],
}

failures = []
for relative, markers in required.items():
    body = (ROOT / relative).read_text(encoding='utf-8')
    for marker in markers:
        if marker not in body:
            failures.append(f'{relative}: missing {marker}')
if failures:
    raise RuntimeError('V3 timeframe role enforcement incomplete:\n- ' + '\n- '.join(failures))

print('V3 alignment roles enforced: Daily/H4=67, Daily/H4/M15=100, H1=fib only.')
