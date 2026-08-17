-- Exact ICT candidate -> broker trade attribution and post-trade learning.
-- Additive: existing lifecycle, signal-learning, and calibration records remain.

alter table public.signal_observations
  add column if not exists candidate_signal_id text,
  add column if not exists broker_trade_id text,
  add column if not exists h1_momentum jsonb,
  add column if not exists m5_authorization jsonb,
  add column if not exists m5_trigger_age_bars integer,
  add column if not exists po3_stage text,
  add column if not exists htf_liquidity_condition jsonb,
  add column if not exists corrective_gate jsonb,
  add column if not exists failure_reasons text[] not null default '{}'::text[];

create index if not exists signal_observations_candidate_signal_idx
  on public.signal_observations (user_id, broker_account_id, candidate_signal_id)
  where candidate_signal_id is not null;

create index if not exists signal_observations_broker_trade_idx
  on public.signal_observations (user_id, broker_account_id, broker_trade_id)
  where broker_trade_id is not null;

alter table public.actual_trade_lifecycles
  add column if not exists signal_observation_id uuid
    references public.signal_observations(id) on delete set null,
  add column if not exists candidate_signal_id text,
  add column if not exists entry_context jsonb not null default '{}'::jsonb,
  add column if not exists d1_state text,
  add column if not exists h4_state text,
  add column if not exists h1_state text,
  add column if not exists h1_momentum jsonb not null default '{}'::jsonb,
  add column if not exists m5_authorization jsonb not null default '{}'::jsonb,
  add column if not exists m5_trigger_age_bars integer,
  add column if not exists po3_stage text,
  add column if not exists htf_liquidity_condition jsonb not null default '{}'::jsonb,
  add column if not exists exit_reason text,
  add column if not exists mfe_pips numeric,
  add column if not exists mae_pips numeric,
  add column if not exists mfe_r numeric,
  add column if not exists mae_r numeric,
  add column if not exists failure_reasons text[] not null default '{}'::text[],
  add column if not exists learning_adjustment jsonb,
  add column if not exists applied_learning_audit_id uuid
    references public.engine_learning_adjustment_audit(id) on delete set null,
  add column if not exists learning_applied boolean not null default false;

create index if not exists actual_trade_lifecycles_candidate_signal_idx
  on public.actual_trade_lifecycles
  (user_id, broker_account_id, candidate_signal_id)
  where candidate_signal_id is not null;

create index if not exists actual_trade_lifecycles_observation_idx
  on public.actual_trade_lifecycles (signal_observation_id)
  where signal_observation_id is not null;

alter table public.engine_learning_adjustment_audit
  add column if not exists adjustment_type text not null default 'pre_trade_calibration',
  add column if not exists applied boolean not null default false,
  add column if not exists applied_at timestamptz,
  add column if not exists source_trade_lifecycle_id uuid
    references public.actual_trade_lifecycles(id) on delete cascade,
  add column if not exists source_signal_observation_id uuid
    references public.signal_observations(id) on delete set null,
  add column if not exists failure_reasons text[] not null default '{}'::text[];

create unique index if not exists engine_learning_post_trade_unique_idx
  on public.engine_learning_adjustment_audit (source_trade_lifecycle_id, adjustment_type);

-- Recover context from the current manual and autonomous trade-log envelopes.
with recovered as (
  select
    id,
    coalesce(
      nullif(opening_snapshot #>> '{item,entryContext,candidateSignalId}', ''),
      nullif(opening_snapshot #>> '{result,entryContext,candidateSignalId}', ''),
      nullif(opening_snapshot #>> '{result,executed,0,entryContext,candidateSignalId}', ''),
      nullif(opening_snapshot #>> '{item,signal,signalId}', ''),
      nullif(opening_snapshot #>> '{signal,signalId}', '')
    ) as candidate_signal_id,
    coalesce(
      opening_snapshot #> '{item,entryContext}',
      opening_snapshot #> '{result,entryContext}',
      opening_snapshot #> '{result,executed,0,entryContext}'
    ) as entry_context
  from public.actual_trade_lifecycles
)
update public.actual_trade_lifecycles lifecycle
set candidate_signal_id = coalesce(lifecycle.candidate_signal_id, recovered.candidate_signal_id),
    entry_context = case
      when lifecycle.entry_context = '{}'::jsonb and recovered.entry_context is not null then recovered.entry_context
      else lifecycle.entry_context
    end,
    updated_at = now()
from recovered
where lifecycle.id = recovered.id
  and (recovered.candidate_signal_id is not null or recovered.entry_context is not null);

with observation_match as (
  select distinct on (lifecycle.id)
    lifecycle.id as lifecycle_id,
    observation.id as observation_id
  from public.actual_trade_lifecycles lifecycle
  join public.signal_observations observation
    on observation.user_id = lifecycle.user_id
   and observation.broker_account_id = lifecycle.broker_account_id
   and (
     (lifecycle.candidate_signal_id is not null and observation.candidate_signal_id = lifecycle.candidate_signal_id)
     or observation.broker_trade_id = lifecycle.broker_trade_id
   )
  where lifecycle.signal_observation_id is null
  order by lifecycle.id, observation.observed_at desc
)
update public.actual_trade_lifecycles lifecycle
set signal_observation_id = observation_match.observation_id,
    updated_at = now()
from observation_match
where lifecycle.id = observation_match.lifecycle_id;

create or replace view public.ict_trade_failure_stats as
select
  lifecycle.user_id,
  lifecycle.broker_account_id,
  lifecycle.engine,
  lifecycle.pair,
  60::integer as horizon_minutes,
  count(*)::integer as outcomes,
  count(*) filter (where lifecycle.result = 'loss')::integer as losses,
  count(*) filter (where 'H1_MOMENTUM_EXHAUSTED' = any(lifecycle.failure_reasons))::integer as exhausted_continuation_failures,
  count(*) filter (where 'H1_ACTIVE_MOMENTUM_NOT_ALIGNED' = any(lifecycle.failure_reasons)
    or 'DIRECTION_CONFIRMATION_FAILURE' = any(lifecycle.failure_reasons))::integer as direction_confirmation_failures,
  count(*) filter (where 'STALE_M5_TRIGGER' = any(lifecycle.failure_reasons))::integer as stale_trigger_failures,
  round(avg(lifecycle.realized_r)::numeric, 4) as expectancy_r,
  round(avg(lifecycle.mfe_r)::numeric, 4) as avg_mfe_r,
  round(avg(lifecycle.mae_r)::numeric, 4) as avg_mae_r,
  max(lifecycle.closed_at) as evidence_end_at
from public.actual_trade_lifecycles lifecycle
where lifecycle.state = 'closed'
  and lifecycle.result in ('win', 'loss', 'breakeven')
group by lifecycle.user_id, lifecycle.broker_account_id, lifecycle.engine, lifecycle.pair;

revoke all on public.ict_trade_failure_stats from anon, authenticated;

comment on column public.actual_trade_lifecycles.entry_context is
  'Immutable ICT entry snapshot: candidate, D1/H4/H1, active H1 momentum, M5 authorization/age, PO3, HTF liquidity, and corrective-gate decision.';
comment on column public.actual_trade_lifecycles.failure_reasons is
  'Stable post-trade failure codes used as engine/pair learning evidence.';
comment on column public.actual_trade_lifecycles.applied_learning_audit_id is
  'Post-trade learning record applied after the exact broker outcome and excursion path were reconciled.';
