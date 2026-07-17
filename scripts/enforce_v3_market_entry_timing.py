#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path):
    return (ROOT / path).read_text(encoding='utf-8')


required = {
    'server/v3MarketMovement.js': [
        "v3-market-movement-entry-v1-2026-07-17",
        "type: 'confirmed_liquidity_sweep'",
        "status: 'late_entry'",
        "timingSource: 'pair_market_movement'",
        'triggerDistanceAtr',
        'fibUsedForConfirmation: false',
    ],
    'server/v3EntryContract.js': [
        'deriveMarketMovementEntryTiming',
        'const movement = v3?.marketMovement',
        'fibUsedForConfirmation: false',
    ],
    'server/v3Engine.js': [
        'analyzeV3MarketMovement',
        "fibConfirmationPolicy: 'diagnostic_only_not_used'",
        'premiumDiscount: null',
        'marketMovement',
    ],
    'server/v3QualityConfirmation.js': [
        'no fresh pair-specific market-movement trigger',
        'triggerDistanceAtr',
        'fibUsedForConfirmation: false',
    ],
    'server/v3IndependentScanner.js': [
        'selectExecutablePrice',
        'entryPriceSide',
        'candidateEntryCalculatedAt',
        'stopLoss',
        'takeProfit',
    ],
    'web/components/scanner-watch-status.tsx': [
        'Candidate entry',
        'Stop loss',
        'Take profit',
        'Movement trigger',
        'Fibonacci is not used as a confirmation',
    ],
    'server/v3FibEntryTiming.test.js': [
        'Fib retracement does not delay a fresh market-movement entry',
        'a completed sweep is late when price has already moved too far',
        'favorable_premium_discount',
    ],
}

forbidden = {
    'server/v3EntryContract.js': [
        'V3_QUALITY_MAX_ENTRY_DISTANCE',
        'fibStatus',
        'fibInEntryWindow',
        'pair-specific H1 retracement',
    ],
    'server/v3QualityConfirmation.js': [
        'favorable_premium_discount',
        'premiumDiscountState',
        'fibRetracementPct',
        'fibInEntryWindow',
    ],
    'server/v3IndependentScanner.js': [
        'premiumDiscountScore) >= 0.75',
    ],
    'web/components/scanner-watch-status.tsx': [
        'Fib timeframe',
        'Fib 38.2%',
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
    raise RuntimeError('V3 market-entry policy incomplete:\n- ' + '\n- '.join(failures))

print('V3 market-entry policy verified: Fib diagnostic only; Stage 2 uses fresh pair-specific movement and displays entry/SL/TP.')
