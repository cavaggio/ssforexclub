# Signal Stack pair-specific learning pipeline

## Purpose

This pipeline records market observations from Auto AI scans, grades future price behavior, calculates pair/time/confirmation expectancy, and creates versioned AI playbooks for each user, broker account, engine, and watchlist pair.

It intentionally learns from more than executed trades. Qualified, watched, rejected, late-entry, and executed setups are stored so the analytics can identify missed winners, premature entries, weak confirmations, and execution-cost failures.

## Safety boundary

The first release is display and shadow only.

- No confidence threshold is changed.
- No R:R, spread, news, margin, duplicate, broker, or drawdown protection is bypassed.
- `pair_ai_playbooks.max_confidence_adjustment` is fixed at `0`.
- Claude can summarize deterministic statistics but cannot change numbers or activate a playbook.
- All learning is scoped by Clerk user ID and broker account ID.

## Supabase migration

Apply:

```text
supabase/migrations/20260727210000_signal_learning_pipeline.sql
```

The migration creates:

- `signal_observations`
- `signal_market_snapshots`
- `signal_outcomes`
- `pair_ai_playbooks`
- `edge_learning_runs`
- `signal_outcome_dataset`
- `pair_summary_stats`
- `pair_time_edge_stats`
- `pair_confirmation_edge_stats`
- `pair_confirmation_combo_stats`
- `pair_regime_edge_stats`

All tables use deny-all RLS. Application access is server-side through `SUPABASE_SERVICE_ROLE_KEY`.

## Runtime flow

1. `/api/cron/auto-ai-trading-extended` sends each successful engine payload to `recordSignalLearningCycle()`.
2. The service stores candidate observations and pair price snapshots.
3. Pending observations are graded at 15, 30, 60, and 120 minutes when later snapshots are available.
4. At 17:30 ET on weekdays, the Railway scheduler reconciles completed broker trades, finalizes MFE/MAE/realized-R learning, runs the end-of-day market-movement study, then refreshes Edge Intelligence.
5. Deterministic pair profiles are built from the 60-minute outcome views.
6. Claude adds a bounded narrative when `ANTHROPIC_API_KEY` is configured.
7. New `pair_ai_playbooks` versions remain display/shadow-only.
8. The Edge Intelligence page renders pair expectancy, scalp-window, confirmation-lift, and playbook charts.

## Environment variables

Existing required variables:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `AUTO_AI_CRON_SECRET`
- `NEXT_BASE_URL`

Optional AI narrative variables:

- `ANTHROPIC_API_KEY`
- `EDGE_CLAUDE_ADVISOR_ENABLED=true`
- `EDGE_CLAUDE_ADVISOR_MODEL`
- `EDGE_CLAUDE_ADVISOR_TIMEOUT_MS`

If the Anthropic key is missing, the statistical playbook still runs and stores a deterministic narrative.

## Activation stages

- Fewer than 10 graded 60-minute outcomes: `display_only`
- 10–29 outcomes: `shadow`
- 30–49 outcomes: `limited_ready`
- 50 or more outcomes: `calibration_ready`

`limited_ready` and `calibration_ready` are evidence labels only. A later, separately reviewed release must validate shadow performance before any bounded live calibration is enabled.
