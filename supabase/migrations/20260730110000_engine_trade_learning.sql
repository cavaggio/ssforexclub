-- Engine-isolated executed-trade learning and bounded calibration audit.
-- Additive only: existing market-study, execution, and risk tables are unchanged.

create or replace view public.engine_executed_outcome_dataset as
select
  d.*,
  case
    when d.result = 'loss' and coalesce(d.direction_correct, false) = false then 'thesis_failure'
    when d.result = 'loss' and d.entry_timing in ('early', 'poor') then 'entry_or_stop_failure'
    when d.result = 'loss' and d.entry_timing = 'late' then 'late_entry_failure'
    when d.result = 'loss' then 'unclassified_loss'
    when d.result = 'win' and d.entry_timing = 'optimal' then 'clean_win'
    when d.result = 'win' and d.entry_timing in ('acceptable', 'late') then 'directional_win_with_execution_drag'
    when d.result = 'win' then 'unclassified_win'
    else 'neutral_or_unresolved'
  end as outcome_classification,
  case
    when d.result = 'win' and d.min_r > -0.35 then 'low_drawdown_win'
    when d.result = 'win' and d.min_r <= -0.75 then 'high_drawdown_win'
    when d.result = 'loss' and d.max_r >= 1 then 'correct_direction_failed_execution'
    when d.result = 'loss' and d.max_r < 0.25 then 'clean_thesis_loss'
    else 'mixed_path'
  end as outcome_quality
from public.signal_outcome_dataset d
where d.status = 'executed';

create or replace view public.engine_executed_pair_stats as
select
  user_id,
  broker_account_id,
  engine,
  pair,
  horizon_minutes,
  min(observed_at) as evidence_start_at,
  max(observed_at) as evidence_end_at,
  count(*) filter (where result in ('win', 'loss', 'breakeven'))::integer as outcomes,
  count(*) filter (where result = 'win')::integer as wins,
  count(*) filter (where result = 'loss')::integer as losses,
  round((100.0 * count(*) filter (where result = 'win') /
    nullif(count(*) filter (where result in ('win', 'loss')), 0))::numeric, 2) as win_rate,
  round(avg(realized_r)::numeric, 4) as expectancy_r,
  round((sum(greatest(realized_r, 0)) /
    nullif(abs(sum(least(realized_r, 0))), 0))::numeric, 4) as profit_factor,
  round(avg(max_r)::numeric, 4) as avg_mfe_r,
  round(avg(min_r)::numeric, 4) as avg_mae_r,
  round((100.0 * avg(case when direction_correct then 1 else 0 end))::numeric, 2) as direction_accuracy,
  round((100.0 * avg(case when target_hit then 1 else 0 end))::numeric, 2) as target_rate,
  round((100.0 * avg(case when stop_hit then 1 else 0 end))::numeric, 2) as stop_rate
from public.engine_executed_outcome_dataset
where result in ('win', 'loss', 'breakeven')
group by user_id, broker_account_id, engine, pair, horizon_minutes;

create or replace view public.engine_executed_context_stats as
select
  user_id,
  broker_account_id,
  engine,
  pair,
  direction,
  lower(session) as session,
  lower(market_regime) as market_regime,
  lower(volatility) as volatility,
  lower(daily_direction) as daily_direction,
  lower(h4_direction) as h4_direction,
  horizon_minutes,
  count(*)::integer as outcomes,
  count(*) filter (where result = 'win')::integer as wins,
  count(*) filter (where result = 'loss')::integer as losses,
  round((100.0 * count(*) filter (where result = 'win') /
    nullif(count(*) filter (where result in ('win', 'loss')), 0))::numeric, 2) as win_rate,
  round(avg(realized_r)::numeric, 4) as expectancy_r,
  round((sum(greatest(realized_r, 0)) /
    nullif(abs(sum(least(realized_r, 0))), 0))::numeric, 4) as profit_factor
from public.engine_executed_outcome_dataset
where result in ('win', 'loss', 'breakeven')
group by user_id, broker_account_id, engine, pair, direction, lower(session),
  lower(market_regime), lower(volatility), lower(daily_direction), lower(h4_direction), horizon_minutes;

create or replace view public.engine_executed_confirmation_stats as
with expanded as (
  select d.*, c.confirmation
  from public.engine_executed_outcome_dataset d
  cross join lateral jsonb_object_keys(coalesce(d.confirmations, '{}'::jsonb)) as c(confirmation)
  where lower(coalesce(d.confirmations ->> c.confirmation, 'false')) in ('true', '1', 'yes')
), baseline as (
  select user_id, broker_account_id, engine, pair, horizon_minutes,
         avg(realized_r) as baseline_expectancy_r
  from public.engine_executed_outcome_dataset
  where result in ('win', 'loss', 'breakeven')
  group by user_id, broker_account_id, engine, pair, horizon_minutes
)
select
  e.user_id,
  e.broker_account_id,
  e.engine,
  e.pair,
  e.confirmation,
  e.horizon_minutes,
  count(*)::integer as outcomes,
  count(*) filter (where e.result = 'win')::integer as wins,
  count(*) filter (where e.result = 'loss')::integer as losses,
  round((100.0 * count(*) filter (where e.result = 'win') /
    nullif(count(*) filter (where e.result in ('win', 'loss')), 0))::numeric, 2) as win_rate,
  round(avg(e.realized_r)::numeric, 4) as expectancy_r,
  round((avg(e.realized_r) - b.baseline_expectancy_r)::numeric, 4) as expectancy_lift_r
from expanded e
join baseline b using (user_id, broker_account_id, engine, pair, horizon_minutes)
where e.result in ('win', 'loss', 'breakeven')
group by e.user_id, e.broker_account_id, e.engine, e.pair, e.confirmation,
  e.horizon_minutes, b.baseline_expectancy_r;

create or replace view public.engine_execution_quality_stats as
select
  user_id,
  broker_account_id,
  engine,
  pair,
  horizon_minutes,
  count(*) filter (where result in ('win', 'loss', 'breakeven'))::integer as outcomes,
  count(*) filter (where entry_timing = 'optimal')::integer as optimal_entries,
  count(*) filter (where entry_timing = 'acceptable')::integer as acceptable_entries,
  count(*) filter (where entry_timing = 'early')::integer as early_entries,
  count(*) filter (where entry_timing = 'late')::integer as late_entries,
  count(*) filter (where entry_timing = 'poor')::integer as poor_entries,
  round((100.0 * count(*) filter (where entry_timing in ('optimal', 'acceptable')) /
    nullif(count(*) filter (where result in ('win', 'loss', 'breakeven')), 0))::numeric, 2) as efficient_entry_rate,
  round((100.0 * count(*) filter (where entry_timing in ('early', 'poor')) /
    nullif(count(*) filter (where result in ('win', 'loss', 'breakeven')), 0))::numeric, 2) as poor_or_early_rate,
  round((100.0 * count(*) filter (where outcome_classification = 'thesis_failure') /
    nullif(count(*) filter (where result = 'loss'), 0))::numeric, 2) as thesis_failure_rate,
  round((100.0 * count(*) filter (where outcome_quality = 'correct_direction_failed_execution') /
    nullif(count(*) filter (where result = 'loss'), 0))::numeric, 2) as correct_direction_failed_execution_rate
from public.engine_executed_outcome_dataset
group by user_id, broker_account_id, engine, pair, horizon_minutes;

create table if not exists public.engine_learning_adjustment_audit (
  id uuid primary key default gen_random_uuid(),
  user_id text,
  broker_account_id text not null,
  environment text not null default 'unknown',
  engine text not null check (engine in ('v3', 'ict', 'ppr')),
  pair text not null,
  direction text,
  observed_at timestamptz not null default now(),
  mode text not null check (mode in ('off', 'shadow', 'limited', 'active')),
  recommendation_stage text not null,
  sample_size integer not null default 0,
  original_confidence numeric,
  market_study_adjustment numeric not null default 0 check (market_study_adjustment between -2 and 2),
  engine_trade_adjustment numeric not null default 0 check (engine_trade_adjustment between -3 and 3),
  combined_adjustment numeric not null default 0 check (combined_adjustment between -5 and 5),
  final_confidence numeric,
  component_adjustments jsonb not null default '[]'::jsonb,
  reasons jsonb not null default '[]'::jsonb,
  hard_gates_preserved jsonb not null default '[]'::jsonb,
  candidate_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists engine_learning_adjustment_audit_scope_idx
  on public.engine_learning_adjustment_audit
  (broker_account_id, engine, pair, observed_at desc);

alter table public.engine_learning_adjustment_audit enable row level security;
revoke all on public.engine_learning_adjustment_audit from anon, authenticated;
revoke all on public.engine_executed_outcome_dataset from anon, authenticated;
revoke all on public.engine_executed_pair_stats from anon, authenticated;
revoke all on public.engine_executed_context_stats from anon, authenticated;
revoke all on public.engine_executed_confirmation_stats from anon, authenticated;
revoke all on public.engine_execution_quality_stats from anon, authenticated;

comment on view public.engine_executed_outcome_dataset is
  'Completed forward outcomes for executed trades only, isolated by user, broker account, engine, and pair.';
comment on table public.engine_learning_adjustment_audit is
  'Per-candidate audit of combined market-study and engine-specific confidence calibration. Hard execution gates remain unchanged.';
