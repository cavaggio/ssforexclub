-- Repair the post-trade learning audit schema and ensure ICT failure evidence is queryable.
-- This is additive/idempotent and is required by both OANDA and FTMO reconciliation.

alter table public.engine_learning_adjustment_audit
  add column if not exists source_trade_lifecycle_id uuid
    references public.actual_trade_lifecycles(id) on delete cascade,
  add column if not exists source_signal_observation_id uuid
    references public.signal_observations(id) on delete set null,
  add column if not exists failure_reasons text[] not null default '{}'::text[];

create unique index if not exists engine_learning_post_trade_unique_idx
  on public.engine_learning_adjustment_audit (source_trade_lifecycle_id, adjustment_type)
  where source_trade_lifecycle_id is not null;

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
  count(*) filter (
    where 'H1_ACTIVE_MOMENTUM_NOT_ALIGNED' = any(lifecycle.failure_reasons)
       or 'DIRECTION_CONFIRMATION_FAILURE' = any(lifecycle.failure_reasons)
  )::integer as direction_confirmation_failures,
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

comment on column public.engine_learning_adjustment_audit.source_trade_lifecycle_id is
  'Exact broker lifecycle that produced this post-trade learning record.';
comment on column public.engine_learning_adjustment_audit.failure_reasons is
  'Stable post-trade failure codes carried from the broker lifecycle.';
