-- Seven-trading-day engine/account accuracy and backfill audit.
-- Additive only. Existing market-study, signal-learning, execution, and risk data remain unchanged.

create or replace view public.engine_executed_outcome_last_7_trading_days as
with distinct_days as (
  select distinct
    user_id,
    broker_account_id,
    engine,
    ny_date
  from public.engine_executed_outcome_dataset
  where horizon_minutes = 60
    and result in ('win', 'loss', 'breakeven')
), ranked_days as (
  select
    user_id,
    broker_account_id,
    engine,
    ny_date,
    dense_rank() over (
      partition by user_id, broker_account_id, engine
      order by ny_date desc
    ) as trading_day_rank
  from distinct_days
)
select
  d.*,
  r.trading_day_rank
from public.engine_executed_outcome_dataset d
join ranked_days r
  on r.user_id = d.user_id
 and r.broker_account_id = d.broker_account_id
 and r.engine = d.engine
 and r.ny_date = d.ny_date
where r.trading_day_rank <= 7;

create or replace view public.engine_account_accuracy_7d as
select
  user_id,
  broker_account_id,
  engine,
  horizon_minutes,
  count(distinct ny_date)::integer as trading_days,
  count(distinct pair)::integer as pairs_studied,
  min(observed_at) as evidence_start_at,
  max(observed_at) as evidence_end_at,
  count(*) filter (where result in ('win', 'loss', 'breakeven'))::integer as outcomes,
  count(*) filter (where result = 'win')::integer as wins,
  count(*) filter (where result = 'loss')::integer as losses,
  count(*) filter (where result = 'breakeven')::integer as breakevens,
  round((100.0 * count(*) filter (where result = 'win') /
    nullif(count(*) filter (where result in ('win', 'loss')), 0))::numeric, 2) as win_rate,
  round(avg(realized_r)::numeric, 4) as expectancy_r,
  round((sum(greatest(realized_r, 0)) /
    nullif(abs(sum(least(realized_r, 0))), 0))::numeric, 4) as profit_factor,
  round(avg(max_r)::numeric, 4) as avg_mfe_r,
  round(avg(min_r)::numeric, 4) as avg_mae_r,
  round((100.0 * avg(case when direction_correct then 1 else 0 end))::numeric, 2) as direction_accuracy,
  round((100.0 * avg(case when target_hit then 1 else 0 end))::numeric, 2) as target_rate,
  round((100.0 * avg(case when stop_hit then 1 else 0 end))::numeric, 2) as stop_rate,
  round((100.0 * count(*) filter (where outcome_classification = 'thesis_failure') /
    nullif(count(*) filter (where result = 'loss'), 0))::numeric, 2) as thesis_failure_rate,
  round((100.0 * count(*) filter (where outcome_quality = 'correct_direction_failed_execution') /
    nullif(count(*) filter (where result = 'loss'), 0))::numeric, 2) as correct_direction_failed_execution_rate
from public.engine_executed_outcome_last_7_trading_days
where result in ('win', 'loss', 'breakeven')
group by user_id, broker_account_id, engine, horizon_minutes;

create or replace view public.engine_account_pair_accuracy_7d as
select
  user_id,
  broker_account_id,
  engine,
  pair,
  horizon_minutes,
  count(distinct ny_date)::integer as trading_days,
  min(observed_at) as evidence_start_at,
  max(observed_at) as evidence_end_at,
  count(*) filter (where result in ('win', 'loss', 'breakeven'))::integer as outcomes,
  count(*) filter (where result = 'win')::integer as wins,
  count(*) filter (where result = 'loss')::integer as losses,
  count(*) filter (where result = 'breakeven')::integer as breakevens,
  round((100.0 * count(*) filter (where result = 'win') /
    nullif(count(*) filter (where result in ('win', 'loss')), 0))::numeric, 2) as win_rate,
  round(avg(realized_r)::numeric, 4) as expectancy_r,
  round((sum(greatest(realized_r, 0)) /
    nullif(abs(sum(least(realized_r, 0))), 0))::numeric, 4) as profit_factor,
  round(avg(max_r)::numeric, 4) as avg_mfe_r,
  round(avg(min_r)::numeric, 4) as avg_mae_r,
  round((100.0 * avg(case when direction_correct then 1 else 0 end))::numeric, 2) as direction_accuracy
from public.engine_executed_outcome_last_7_trading_days
where result in ('win', 'loss', 'breakeven')
group by user_id, broker_account_id, engine, pair, horizon_minutes;

create table if not exists public.engine_learning_backfill_runs (
  id uuid primary key default gen_random_uuid(),
  requested_at timestamptz not null default now(),
  completed_at timestamptz,
  requested_trading_days integer not null default 7 check (requested_trading_days between 1 and 30),
  calendar_lookback_days integer not null default 14 check (calendar_lookback_days between 1 and 60),
  source text not null default 'scheduler',
  status text not null default 'running' check (status in ('running', 'completed', 'partial', 'failed')),
  accounts_processed integer not null default 0,
  engine_profiles_processed integer not null default 0,
  observations_considered integer not null default 0,
  outcomes_written integer not null default 0,
  results jsonb not null default '[]'::jsonb,
  error text,
  created_at timestamptz not null default now()
);

create index if not exists engine_learning_backfill_runs_requested_idx
  on public.engine_learning_backfill_runs (requested_at desc);

alter table public.engine_learning_backfill_runs enable row level security;

revoke all on public.engine_learning_backfill_runs from anon, authenticated;
revoke all on public.engine_executed_outcome_last_7_trading_days from anon, authenticated;
revoke all on public.engine_account_accuracy_7d from anon, authenticated;
revoke all on public.engine_account_pair_accuracy_7d from anon, authenticated;

comment on view public.engine_account_accuracy_7d is
  'Per broker account and engine accuracy over that scope''s most recent seven executed-trade dates, using 60-minute outcomes for live calibration.';

comment on view public.engine_account_pair_accuracy_7d is
  'Per broker account, engine, and pair accuracy over that engine/account scope''s most recent seven executed-trade dates.';

comment on table public.engine_learning_backfill_runs is
  'Audit record for bounded historical grading/backfill runs. Backfills write outcomes only and never submit trades.';
