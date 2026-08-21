-- Rolling 30-day Edge Intelligence knowledge and retention policy.
--
-- Goals:
-- 1) Give Edge Intelligence one enriched broker-outcome dataset that combines
--    exact trade P/L with entry context, H1/M5 state, PO3/liquidity, MFE/MAE,
--    failure reasons, and applied learning.
-- 2) Keep only 30 calendar days of raw/derived learning history so stale market
--    regimes do not cloud current logic and storage remains bounded.
-- 3) Never delete an actively open broker lifecycle.
--
-- This migration changes learning/history only. It does not alter entry gates,
-- confidence thresholds, risk, SL/TP, Profit Protection, ICT, PPR, or V3 logic.

create extension if not exists pg_cron;

-- Fail with one actionable prerequisite message if the core learning tables
-- themselves are unavailable. Column-level drift is repaired below with
-- additive IF NOT EXISTS compatibility changes so production environments that
-- missed a prior column migration can still apply this migration safely.
do $$
declare
  missing_relations text[];
begin
  select array_agg(required_relation order by required_relation)
    into missing_relations
  from (values
    ('public.trade_logs'),
    ('public.actual_trade_lifecycles'),
    ('public.signal_observations'),
    ('public.signal_outcomes'),
    ('public.signal_market_snapshots'),
    ('public.engine_learning_adjustment_audit'),
    ('public.pair_ai_playbooks'),
    ('public.edge_learning_runs'),
    ('public.engine_learning_backfill_runs'),
    ('public.pair_playbook_priority_audit')
  ) as required(required_relation)
  where to_regclass(required_relation) is null;

  if missing_relations is not null then
    raise exception using
      errcode = 'P0001',
      message = 'Edge Intelligence 30-day retention prerequisites are missing: ' || array_to_string(missing_relations, ', '),
      hint = 'Apply the Signal Learning, Engine Trade Learning, Actual Trade Lifecycle, and Pair Playbook Priority base migrations first.';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Column-level compatibility repair
-- ---------------------------------------------------------------------------
-- Production can contain the learning tables while still missing columns from
-- a later ICT context migration. Repair those omissions additively rather than
-- making the 30-day view fail on the first missing column. Existing columns,
-- data, constraints, and execution logic are not changed.

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
  add column if not exists learning_audit_id uuid
    references public.engine_learning_adjustment_audit(id) on delete set null,
  add column if not exists applied_learning_audit_id uuid
    references public.engine_learning_adjustment_audit(id) on delete set null,
  add column if not exists learning_applied boolean not null default false;

alter table public.engine_learning_adjustment_audit
  add column if not exists adjustment_type text not null default 'pre_trade_calibration',
  add column if not exists applied boolean not null default false,
  add column if not exists applied_at timestamptz;

create index if not exists signal_observations_candidate_signal_idx
  on public.signal_observations (user_id, broker_account_id, candidate_signal_id)
  where candidate_signal_id is not null;

create index if not exists signal_observations_broker_trade_idx
  on public.signal_observations (user_id, broker_account_id, broker_trade_id)
  where broker_trade_id is not null;

create index if not exists actual_trade_lifecycles_observation_idx
  on public.actual_trade_lifecycles (signal_observation_id)
  where signal_observation_id is not null;

create index if not exists actual_trade_lifecycles_candidate_signal_idx
  on public.actual_trade_lifecycles
  (user_id, broker_account_id, candidate_signal_id)
  where candidate_signal_id is not null;

-- Hot-path indexes for rolling-history reads and expiration deletes.
create index if not exists actual_trade_lifecycles_edge_30d_idx
  on public.actual_trade_lifecycles (user_id, broker_account_id, closed_at desc)
  where state = 'closed' and result in ('win', 'loss', 'breakeven');

create index if not exists trade_logs_edge_30d_idx
  on public.trade_logs (user_id, broker_account_id, created_at desc);

create index if not exists signal_observations_retention_idx
  on public.signal_observations (observed_at);

create index if not exists signal_market_snapshots_retention_idx
  on public.signal_market_snapshots (observed_at);

create index if not exists engine_learning_adjustment_retention_idx
  on public.engine_learning_adjustment_audit (created_at);

-- One enriched, account-scoped Edge Intelligence knowledge surface. The view is
-- intentionally limited to 30 calendar days even before the purge job runs, so
-- stale data can never leak into the Edge dashboard because a cron run is late.
create or replace view public.edge_intelligence_trade_knowledge_30d as
select
  lifecycle.id,
  lifecycle.user_id,
  lifecycle.broker_account_id,
  lifecycle.environment,
  lifecycle.engine,
  lifecycle.broker_trade_id,
  lifecycle.candidate_signal_id,
  lifecycle.pair,
  lifecycle.direction,
  lifecycle.opened_at,
  lifecycle.closed_at,
  lifecycle.state,
  lifecycle.result,
  lifecycle.entry_price,
  lifecycle.exit_price,
  lifecycle.units,
  lifecycle.stop_loss,
  lifecycle.take_profit,
  lifecycle.realized_pl,
  lifecycle.realized_r,
  lifecycle.entry_context,
  lifecycle.d1_state,
  lifecycle.h4_state,
  lifecycle.h1_state,
  case
    when lifecycle.h1_momentum <> '{}'::jsonb then lifecycle.h1_momentum
    else coalesce(observation.h1_momentum, '{}'::jsonb)
  end as h1_momentum,
  case
    when lifecycle.m5_authorization <> '{}'::jsonb then lifecycle.m5_authorization
    else coalesce(observation.m5_authorization, '{}'::jsonb)
  end as m5_authorization,
  coalesce(lifecycle.m5_trigger_age_bars, observation.m5_trigger_age_bars) as m5_trigger_age_bars,
  coalesce(lifecycle.po3_stage, observation.po3_stage) as po3_stage,
  case
    when lifecycle.htf_liquidity_condition <> '{}'::jsonb then lifecycle.htf_liquidity_condition
    else coalesce(observation.htf_liquidity_condition, '{}'::jsonb)
  end as htf_liquidity_condition,
  lifecycle.exit_reason,
  lifecycle.mfe_pips,
  lifecycle.mae_pips,
  lifecycle.mfe_r,
  lifecycle.mae_r,
  case
    when cardinality(lifecycle.failure_reasons) > 0 then lifecycle.failure_reasons
    else coalesce(observation.failure_reasons, '{}'::text[])
  end as failure_reasons,
  lifecycle.learning_adjustment,
  lifecycle.learning_applied,
  lifecycle.entry_context #> '{impulseLifecycle}' as impulse_lifecycle,
  observation.session,
  observation.market_regime,
  observation.volatility,
  observation.daily_direction,
  observation.h4_direction,
  observation.h1_direction,
  observation.corrective_gate,
  audit.id as applied_learning_audit_id,
  audit.adjustment_type as applied_learning_type,
  audit.combined_adjustment as applied_combined_adjustment,
  audit.reasons as applied_learning_reasons,
  audit.applied_at as applied_learning_at,
  lifecycle.opening_snapshot,
  lifecycle.broker_snapshot,
  lifecycle.reconciled_at,
  lifecycle.updated_at
from public.actual_trade_lifecycles lifecycle
left join public.signal_observations observation
  on observation.id = lifecycle.signal_observation_id
left join public.engine_learning_adjustment_audit audit
  on audit.id = coalesce(lifecycle.applied_learning_audit_id, lifecycle.learning_audit_id)
where lifecycle.state = 'closed'
  and lifecycle.result in ('win', 'loss', 'breakeven')
  and coalesce(lifecycle.closed_at, lifecycle.opened_at, lifecycle.created_at) >= now() - interval '30 days';

revoke all on public.edge_intelligence_trade_knowledge_30d from anon, authenticated;

comment on view public.edge_intelligence_trade_knowledge_30d is
  'Rolling 30-day Edge Intelligence trade knowledge: exact broker result plus entry context, H1/M5 state, PO3/liquidity, MFE/MAE, failure codes, impulse lifecycle, and applied learning.';

-- Fixed 30-day purge. Open broker lifecycles are always preserved even if they
-- are older than 30 days; closed/unresolved historical learning is expendable.
create or replace function public.purge_edge_intelligence_expired_data()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  cutoff_at timestamptz := now() - interval '30 days';
  outcomes_deleted integer := 0;
  observations_deleted integer := 0;
  snapshots_deleted integer := 0;
  lifecycles_deleted integer := 0;
  audits_deleted integer := 0;
  trade_logs_deleted integer := 0;
  playbooks_deleted integer := 0;
  playbook_audits_deleted integer := 0;
  edge_runs_deleted integer := 0;
  backfill_runs_deleted integer := 0;
begin
  -- Delete child forward outcomes first so the returned audit count is exact.
  delete from public.signal_outcomes outcome
  using public.signal_observations observation
  where outcome.observation_id = observation.id
    and observation.observed_at < cutoff_at;
  get diagnostics outcomes_deleted = row_count;

  delete from public.signal_market_snapshots
  where observed_at < cutoff_at;
  get diagnostics snapshots_deleted = row_count;

  delete from public.signal_observations
  where observed_at < cutoff_at;
  get diagnostics observations_deleted = row_count;

  -- Never remove an actively open broker trade. Old unresolved records may be
  -- dropped because they cannot contribute a scored Edge outcome after 30 days.
  delete from public.actual_trade_lifecycles
  where state <> 'open'
    and coalesce(closed_at, opened_at, created_at) < cutoff_at;
  get diagnostics lifecycles_deleted = row_count;

  delete from public.engine_learning_adjustment_audit
  where coalesce(applied_at, observed_at, created_at) < cutoff_at;
  get diagnostics audits_deleted = row_count;

  delete from public.trade_logs
  where created_at < cutoff_at;
  get diagnostics trade_logs_deleted = row_count;

  -- Persisted summaries/audits must expire too; otherwise a current flag could
  -- keep a playbook derived from stale regimes alive after its raw evidence aged out.
  delete from public.pair_ai_playbooks
  where generated_at < cutoff_at;
  get diagnostics playbooks_deleted = row_count;

  delete from public.pair_playbook_priority_audit
  where created_at < cutoff_at;
  get diagnostics playbook_audits_deleted = row_count;

  delete from public.edge_learning_runs
  where started_at < cutoff_at;
  get diagnostics edge_runs_deleted = row_count;

  delete from public.engine_learning_backfill_runs
  where requested_at < cutoff_at;
  get diagnostics backfill_runs_deleted = row_count;

  return jsonb_build_object(
    'cutoffAt', cutoff_at,
    'retentionDays', 30,
    'signalOutcomesDeleted', outcomes_deleted,
    'signalObservationsDeleted', observations_deleted,
    'marketSnapshotsDeleted', snapshots_deleted,
    'tradeLifecyclesDeleted', lifecycles_deleted,
    'learningAuditsDeleted', audits_deleted,
    'tradeLogsDeleted', trade_logs_deleted,
    'playbooksDeleted', playbooks_deleted,
    'playbookPriorityAuditsDeleted', playbook_audits_deleted,
    'edgeLearningRunsDeleted', edge_runs_deleted,
    'backfillRunsDeleted', backfill_runs_deleted
  );
end;
$$;

revoke all on function public.purge_edge_intelligence_expired_data() from public, anon, authenticated;
grant execute on function public.purge_edge_intelligence_expired_data() to service_role;

comment on function public.purge_edge_intelligence_expired_data() is
  'Deletes Edge Intelligence and engine-learning history older than 30 calendar days while preserving active open broker lifecycles.';

-- Run once daily. The knowledge view is already hard-limited to 30 days, so a
-- delayed cron can only affect storage, never the logic/analytics evidence window.
do $$
declare
  existing_job record;
begin
  for existing_job in
    select jobid from cron.job where jobname = 'edge-intelligence-30d-retention'
  loop
    perform cron.unschedule(existing_job.jobid);
  end loop;
end
$$;

select cron.schedule(
  'edge-intelligence-30d-retention',
  '15 6 * * *',
  'select public.purge_edge_intelligence_expired_data();'
);

-- Enforce the policy immediately for already-stale rows.
select public.purge_edge_intelligence_expired_data();
