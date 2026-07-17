#!/usr/bin/env python3
from pathlib import Path
import runpy

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
        'refreshIndependentV3CandidateForExecution',
    ],
    'server/v3ManualExecution.js': [
        'V3_MANUAL_EXECUTION_POLICY_VERSION',
        'validateRecentQualifiedV3Signal',
        'refreshIndependentV3CandidateForExecution',
        'Fresh V3 Stage 1/Stage 2 validation failed',
        "source: 'v3_recent_signals_manual'",
    ],
    'scripts/apply_v3_recent_signals_execution.py': [
        'executeRecentQualifiedV3Signal',
        '[INTERNAL V3 RECENT SIGNAL]',
    ],
    'web/app/api/scanner/trade/route.ts': [
        'Only independent native V3 Recent Signals can be executed manually',
        'V3 Stage 1 is not complete',
        'V3 Stage 2 is not complete',
        "executionSource: 'recent_signals_v3'",
    ],
    'web/components/scanner-watch-status.tsx': [
        'Candidate entry',
        'Stop loss',
        'Take profit',
        'Movement trigger',
        'Fibonacci is not used as a confirmation',
    ],
    'web/components/scanner-status-card.tsx': [
        'Recent signals',
        "fetch('/api/scanner/trade'",
        'Execute Paper Trade',
        'Trade executed',
    ],
    'server/v3FibEntryTiming.test.js': [
        'Fib retracement does not delay a fresh market-movement entry',
        'a completed sweep is late when price has already moved too far',
        'favorable_premium_discount',
    ],
    'server/v3ManualExecution.test.js': [
        'manual execution refreshes the exact pair before placing an order',
        'manual execution blocks a stale Recent Signal',
        'manual execution rejects legacy or incomplete signals',
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

print('V3 market-entry policy verified: pair-specific movement, safe Recent Signals execution, and Fib diagnostic only.')

# Apply PPR only after every V3 generator/verifier has completed. This keeps
# the PPR strategy isolated while making its shared broker-routing hooks
# authoritative and idempotent for prestart, prebuild, and pretest.
runpy.run_path(str(ROOT / 'scripts' / 'apply_ppr_engine.py'), run_name='__main__')
