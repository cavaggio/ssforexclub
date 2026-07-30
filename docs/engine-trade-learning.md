# Engine-isolated trade learning with daily market context

## Decision order

Every candidate keeps the existing deterministic engine analysis and hard gates. Calibration runs in this order:

1. The existing Daily/4H market study contributes at most **±2 confidence points**.
2. Completed executed trades from the same broker account, engine, and pair contribute at most **±3 points**.
3. The combined change is capped at **±5 points**.
4. Risk, daily drawdown, minimum R:R, spread, news, margin, duplicate-trade, and broker authorization gates remain authoritative.

ICT outcomes never adjust PPR or V3. PPR outcomes never adjust ICT or V3. V3 outcomes never adjust ICT or PPR. Shared market facts remain available through the existing market-study calibration.

## Evidence used

The executed-trade learner evaluates 60-minute graded outcomes for:

- engine and pair expectancy;
- matching direction, session, regime, volatility, Daily direction, and 4H direction;
- confirmation lift for the current engine;
- entry-quality history, including optimal, acceptable, early, late, and poor entries.

The migration also classifies losses as thesis, entry/stop, late-entry, or unclassified failures and distinguishes clean wins from wins with execution drag.

## Sample protection

- Fewer than 10 outcomes: display only.
- 10–29 outcomes: shadow only; the recommendation is logged but not applied.
- 30–99 outcomes: limited live calibration with sample-size shrinkage.
- 100+ outcomes: full eligible weighting, still capped at ±3 engine points.

## Runtime variables

- `ENGINE_TRADE_LEARNING_MODE=limited` — default; allowed values are `off`, `shadow`, `limited`, and `active`.
- `ENGINE_TRADE_LEARNING_LIVE_MIN=30`
- `ENGINE_TRADE_LEARNING_FULL_WEIGHT_MIN=100`
- `ENGINE_TRADE_LEARNING_MAX_ADJUSTMENT=3`
- `ENGINE_TRADE_LEARNING_CACHE_MS=300000`

## Required migration

Apply:

```text
supabase/migrations/20260730110000_engine_trade_learning.sql
```

Without the migration, the engine-specific layer degrades to zero adjustment and the existing market study continues operating.

## Audit

Each calibration attempt writes to `engine_learning_adjustment_audit`, including the original confidence, market-study adjustment, engine-trade adjustment, final confidence, evidence components, sample size, and preserved hard gates.
