-- Signal Stack pair-specific learning pipeline.
-- Additive only: no existing execution, risk, or trade-log tables are changed.

create extension if not exists pgcrypto;

create table if not exists public.signal_observations (
  id uuid primary key default gen_random_uuid(),
  observation_key text not null unique,
  user_id text not null,
  broker_account_id text not null,
  environment text not null default 'unknown',
  engine text not null check (engine in ('v3', 'ict', 'ppr')),
  pair text not null,
  direction text check (direction in ('long', 'short')),
  observed_at timestamptz not null default now(),
  ny_date date not null,
  ny_minute integer not null check (ny_minute between 0 and 1439),
  time_bucket_15m text not null,
  session text,
  run_id text,
  scan_mode text,
  source_bucket text,
  status text not null check (status in (
    'candidate', 'watching', 'near_qualified', 'hot_watch', 'late_entry',
    'qualified', 'executed', 'rejected', 'market_study'
  )),
  rejection_reason text,
  confidence numeric,
  adjusted_confidence numeric,
  signal_score numeric,
  entry_price numeric,
  stop_loss numeric,
  take_profit numeric,
  projected_rr numeric,
  spread_pips numeric,
  atr_pips numeric,
  market_regime text,
  volatility text,
  daily_direction text,
  h4_direction text,
  h1_direction text,
  m15_direction text,
  m5_direction text,
  liquidity_context jsonb not null default '{}'::jsonb,
  confirmations jsonb not null default '{}'::jsonb,
  confirmation_signature text not null default 'none',
  missing_confirmations text[] not null default '{}'::text[],
  daily_study jsonb,
  feature_snapshot jsonb not null default '{}'::jsonb,
  raw_payload jsonb,
  outcome_state text not null default 'pending' check (outcome_state in ('pending', 'partial', 'resolved', 'ungradeable')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists signal_observations_scope_idx
  on public.signal_observations (user_id, broker_account_id, engine, pair, observed_at desc);
create index if not exists signal_observations_pending_idx
  on public.signal_observations (user_id, broker_account_id, outcome_state, observed_at)
  where outcome_state in ('pending', 'partial');
create index if not exists signal_observations_confirmation_idx
  on public.signal_observations using gin (confirmations);

create table if not exists public.signal_market_snapshots (
  id uuid primary key default gen_random_uuid(),
  snapshot_key text not null unique,
  user_id text not null,
  broker_account_id text not null,
  environment text not null default 'unknown',
  engine text not null check (engine in ('v3', 'ict', 'ppr')),
  pair text not null,
  observed_at timestamptz not null default now(),
  bid numeric,
  ask numeric,
  mid_price numeric not null,
  spread_pips numeric,
  source_run_id text,
  raw_payload jsonb,
  created_at timestamptz not null default now()
);

create index if not exists signal_market_snapshots_lookup_idx
  on public.signal_market_snapshots (user_id, broker_account_id, engine, pair, observed_at);

create table if not exists public.signal_outcomes (
  id uuid primary key default gen_random_uuid(),
  observation_id uuid not null references public.signal_observations(id) on delete cascade,
  horizon_minutes integer not null check (horizon_minutes in (15, 30, 60, 120)),
  graded_at timestamptz not null default now(),
  snapshot_count integer not null default 0,
  horizon_price numeric,
  max_favorable_price numeric,
  max_adverse_price numeric,
  mfe_pips numeric,
  mae_pips numeric,
  max_r numeric,
  min_r numeric,
  realized_r numeric,
  target_hit boolean not null default false,
  stop_hit boolean not null default false,
  target_hit_at timestamptz,
  stop_hit_at timestamptz,
  direction_correct boolean,
  entry_timing text check (entry_timing in ('optimal', 'acceptable', 'early', 'late', 'poor', 'unknown')),
  result text not null check (result in ('win', 'loss', 'breakeven', 'unresolved')),
  raw_payload jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (observation_id, horizon_minutes)
);

create index if not exists signal_outcomes_horizon_idx
  on public.signal_outcomes (horizon_minutes, result, graded_at desc);

create table if not exists public.pair_ai_playbooks (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  broker_account_id text not null,
  engine text not null check (engine in ('v3', 'ict', 'ppr')),
  pair text not null,
  version integer not null,
  is_current boolean not null default true,
  status text not null default 'display_only' check (status in ('display_only', 'shadow', 'ready', 'active', 'retired')),
  generated_at timestamptz not null default now(),
  evidence_start_at timestamptz,
  evidence_end_at timestamptz,
  sample_size integer not null default 0,
  wins integer not null default 0,
  losses integer not null default 0,
  win_rate numeric,
  expectancy_r numeric,
  profit_factor numeric,
  recommendation_stage text not null,
  preferred_scalp_windows jsonb not null default '[]'::jsonb,
  valuable_confirmations jsonb not null default '[]'::jsonb,
  weak_confirmations jsonb not null default '[]'::jsonb,
  avoid_conditions jsonb not null default '[]'::jsonb,
  statistical_profile jsonb not null default '{}'::jsonb,
  ai_summary jsonb not null default '{}'::jsonb,
  validator jsonb not null default '{}'::jsonb,
  max_confidence_adjustment numeric not null default 0,
  created_at timestamptz not null default now(),
  unique (user_id, broker_account_id, engine, pair, version)
);

create unique index if not exists pair_ai_playbooks_current_idx
  on public.pair_ai_playbooks (user_id, broker_account_id, engine, pair)
  where is_current = true;

create table if not exists public.edge_learning_runs (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  broker_account_id text not null,
  engine text not null check (engine in ('v3', 'ict', 'ppr')),
  run_type text not null check (run_type in ('scan_capture', 'outcome_grading', 'playbook_refresh')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  observations_written integer not null default 0,
  snapshots_written integer not null default 0,
  outcomes_written integer not null default 0,
  playbooks_written integer not null default 0,
  success boolean,
  error text,
  metadata jsonb not null default '{}'::jsonb
);

create or replace view public.signal_outcome_dataset as
select
  o.user_id,
  o.broker_account_id,
  o.environment,
  o.engine,
  o.pair,
  o.direction,
  o.observed_at,
  o.ny_date,
  o.ny_minute,
  o.time_bucket_15m,
  o.session,
  o.scan_mode,
  o.source_bucket,
  o.status,
  o.rejection_reason,
  o.confidence,
  o.adjusted_confidence,
  o.signal_score,
  o.entry_price,
  o.stop_loss,
  o.take_profit,
  o.projected_rr,
  o.spread_pips,
  o.atr_pips,
  o.market_regime,
  o.volatility,
  o.daily_direction,
  o.h4_direction,
  o.h1_direction,
  o.m15_direction,
  o.m5_direction,
  o.confirmations,
  o.confirmation_signature,
  o.missing_confirmations,
  s.horizon_minutes,
  s.snapshot_count,
  s.mfe_pips,
  s.mae_pips,
  s.max_r,
  s.min_r,
  s.realized_r,
  s.target_hit,
  s.stop_hit,
  s.direction_correct,
  s.entry_timing,
  s.result,
  s.graded_at
from public.signal_observations o
join public.signal_outcomes s on s.observation_id = o.id;

create or replace view public.pair_summary_stats as
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
  round(100.0 * count(*) filter (where result = 'win') /
    nullif(count(*) filter (where result in ('win', 'loss')), 0), 2) as win_rate,
  round(avg(realized_r)::numeric, 4) as expectancy_r,
  round((sum(greatest(realized_r, 0)) /
    nullif(abs(sum(least(realized_r, 0))), 0))::numeric, 4) as profit_factor,
  round(avg(max_r)::numeric, 4) as avg_mfe_r,
  round(avg(min_r)::numeric, 4) as avg_mae_r,
  round(100.0 * avg(case when direction_correct then 1 else 0 end), 2) as direction_accuracy,
  round(100.0 * avg(case when target_hit then 1 else 0 end), 2) as target_rate,
  round(100.0 * avg(case when stop_hit then 1 else 0 end), 2) as stop_rate
from public.signal_outcome_dataset
group by user_id, broker_account_id, engine, pair, horizon_minutes;

create or replace view public.pair_time_edge_stats as
select
  user_id,
  broker_account_id,
  engine,
  pair,
  direction,
  session,
  time_bucket_15m,
  horizon_minutes,
  count(*)::integer as outcomes,
  count(*) filter (where result = 'win')::integer as wins,
  count(*) filter (where result = 'loss')::integer as losses,
  round(100.0 * count(*) filter (where result = 'win') /
    nullif(count(*) filter (where result in ('win', 'loss')), 0), 2) as win_rate,
  round(avg(realized_r)::numeric, 4) as expectancy_r,
  round((sum(greatest(realized_r, 0)) /
    nullif(abs(sum(least(realized_r, 0))), 0))::numeric, 4) as profit_factor,
  round(avg(max_r)::numeric, 4) as avg_mfe_r,
  round(avg(min_r)::numeric, 4) as avg_mae_r
from public.signal_outcome_dataset
group by user_id, broker_account_id, engine, pair, direction, session, time_bucket_15m, horizon_minutes;

create or replace view public.pair_confirmation_edge_stats as
with expanded as (
  select d.*, c.confirmation
  from public.signal_outcome_dataset d
  cross join lateral jsonb_object_keys(coalesce(d.confirmations, '{}'::jsonb)) as c(confirmation)
  where lower(coalesce(d.confirmations ->> c.confirmation, 'false')) in ('true', '1', 'yes')
), baseline as (
  select user_id, broker_account_id, engine, pair, horizon_minutes,
         avg(realized_r) as baseline_expectancy_r
  from public.signal_outcome_dataset
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
  round(100.0 * count(*) filter (where e.result = 'win') /
    nullif(count(*) filter (where e.result in ('win', 'loss')), 0), 2) as win_rate,
  round(avg(e.realized_r)::numeric, 4) as expectancy_r,
  round((avg(e.realized_r) - b.baseline_expectancy_r)::numeric, 4) as expectancy_lift_r,
  round((sum(greatest(e.realized_r, 0)) /
    nullif(abs(sum(least(e.realized_r, 0))), 0))::numeric, 4) as profit_factor
from expanded e
join baseline b using (user_id, broker_account_id, engine, pair, horizon_minutes)
group by e.user_id, e.broker_account_id, e.engine, e.pair, e.confirmation,
         e.horizon_minutes, b.baseline_expectancy_r;

create or replace view public.pair_confirmation_combo_stats as
select
  user_id,
  broker_account_id,
  engine,
  pair,
  confirmation_signature,
  horizon_minutes,
  count(*)::integer as outcomes,
  count(*) filter (where result = 'win')::integer as wins,
  count(*) filter (where result = 'loss')::integer as losses,
  round(100.0 * count(*) filter (where result = 'win') /
    nullif(count(*) filter (where result in ('win', 'loss')), 0), 2) as win_rate,
  round(avg(realized_r)::numeric, 4) as expectancy_r,
  round((sum(greatest(realized_r, 0)) /
    nullif(abs(sum(least(realized_r, 0))), 0))::numeric, 4) as profit_factor
from public.signal_outcome_dataset
group by user_id, broker_account_id, engine, pair, confirmation_signature, horizon_minutes;

create or replace view public.pair_regime_edge_stats as
select
  user_id,
  broker_account_id,
  engine,
  pair,
  direction,
  market_regime,
  volatility,
  daily_direction,
  h4_direction,
  horizon_minutes,
  count(*)::integer as outcomes,
  round(100.0 * count(*) filter (where result = 'win') /
    nullif(count(*) filter (where result in ('win', 'loss')), 0), 2) as win_rate,
  round(avg(realized_r)::numeric, 4) as expectancy_r,
  round((sum(greatest(realized_r, 0)) /
    nullif(abs(sum(least(realized_r, 0))), 0))::numeric, 4) as profit_factor
from public.signal_outcome_dataset
group by user_id, broker_account_id, engine, pair, direction, market_regime,
         volatility, daily_direction, h4_direction, horizon_minutes;

alter table public.signal_observations enable row level security;
alter table public.signal_market_snapshots enable row level security;
alter table public.signal_outcomes enable row level security;
alter table public.pair_ai_playbooks enable row level security;
alter table public.edge_learning_runs enable row level security;

revoke all on public.signal_observations from anon, authenticated;
revoke all on public.signal_market_snapshots from anon, authenticated;
revoke all on public.signal_outcomes from anon, authenticated;
revoke all on public.pair_ai_playbooks from anon, authenticated;
revoke all on public.edge_learning_runs from anon, authenticated;
revoke all on public.signal_outcome_dataset from anon, authenticated;
revoke all on public.pair_summary_stats from anon, authenticated;
revoke all on public.pair_time_edge_stats from anon, authenticated;
revoke all on public.pair_confirmation_edge_stats from anon, authenticated;
revoke all on public.pair_confirmation_combo_stats from anon, authenticated;
revoke all on public.pair_regime_edge_stats from anon, authenticated;

comment on table public.signal_observations is
  'Account-scoped market and signal observations, including rejected and non-executed setups.';
comment on table public.signal_outcomes is
  'Forward outcome labels at fixed horizons for deterministic pair/time/confirmation learning.';
comment on table public.pair_ai_playbooks is
  'Versioned, bounded pair playbooks. New versions remain display/shadow until separately activated.';
