-- Connect actual broker outcomes, applied calibration audits, and broad market
-- scan outcomes for bounded engine learning. Actual OANDA P&L/R remains primary.

-- This is an additive integration migration, not a bootstrap migration. Refuse
-- to run out of order so production gets one actionable error instead of a
-- succession of ambiguous "relation does not exist" failures.
do $$
declare
  missing_relations text[];
begin
  select array_agg(required_relation order by required_relation)
  into missing_relations
  from (values
    ('public.signal_outcome_dataset'),
    ('public.engine_learning_adjustment_audit'),
    ('public.engine_executed_context_stats'),
    ('public.engine_executed_confirmation_stats'),
    ('public.engine_execution_quality_stats'),
    ('public.actual_trade_lifecycles'),
    ('public.engine_actual_account_accuracy_7d'),
    ('public.engine_actual_account_pair_accuracy_7d'),
    ('public.engine_combined_pair_stats')
  ) as required(required_relation)
  where to_regclass(required_relation) is null;

  if missing_relations is not null then
    raise exception using
      errcode = 'P0001',
      message = 'Three-dataset learning prerequisites are missing: ' || array_to_string(missing_relations, ', '),
      hint = 'Apply migrations 20260727210000, 20260730110000, 20260730143000, 20260730162000, and 20260730162500 in order, then rerun 20260815120000.';
  end if;
end
$$;

alter table public.actual_trade_lifecycles
  add column if not exists learning_audit_id uuid
    references public.engine_learning_adjustment_audit(id) on delete set null;

create index if not exists actual_trade_lifecycles_learning_audit_idx
  on public.actual_trade_lifecycles (learning_audit_id)
  where learning_audit_id is not null;

-- Recover exact calibration IDs already embedded in sanitized opening payloads.
with extracted as (
  select
    id,
    coalesce(
      nullif(opening_snapshot #>> '{signal,combinedLearningContext,auditId}', ''),
      nullif(opening_snapshot #>> '{executed,signal,combinedLearningContext,auditId}', ''),
      nullif(opening_snapshot #>> '{item,signal,combinedLearningContext,auditId}', ''),
      nullif(opening_snapshot #>> '{result,signal,combinedLearningContext,auditId}', ''),
      nullif(opening_snapshot #>> '{result,executed,0,signal,combinedLearningContext,auditId}', ''),
      nullif(opening_snapshot #>> '{result,learningAuditId}', ''),
      nullif(opening_snapshot #>> '{trade,learningAuditId}', ''),
      nullif(opening_snapshot #>> '{combinedLearningContext,auditId}', '')
    ) as audit_id_text
  from public.actual_trade_lifecycles
  where learning_audit_id is null
)
update public.actual_trade_lifecycles lifecycle
set learning_audit_id = extracted.audit_id_text::uuid,
    updated_at = now()
from extracted
where lifecycle.id = extracted.id
  and extracted.audit_id_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  and exists (
    select 1
    from public.engine_learning_adjustment_audit audit
    where audit.id = extracted.audit_id_text::uuid
  );

-- Broad scan evidence captures opportunities the executor never took, plus the
-- timing labels produced by signal_outcomes. Rejected hard-gate failures are not
-- treated as actionable missed winners.
create or replace view public.engine_signal_learning_stats as
select
  user_id,
  broker_account_id,
  engine,
  pair,
  horizon_minutes,
  min(observed_at) as evidence_start_at,
  max(graded_at) as evidence_end_at,
  count(*) filter (where result in ('win', 'loss', 'breakeven'))::integer as outcomes,
  count(*) filter (where entry_timing is not null and entry_timing <> 'unknown')::integer as timing_outcomes,
  count(*) filter (
    where entry_timing in ('late', 'poor') or status = 'late_entry'
  )::integer as late_or_poor_entries,
  round((100.0 * count(*) filter (
    where entry_timing in ('late', 'poor') or status = 'late_entry'
  ) / nullif(count(*) filter (
    where entry_timing is not null and entry_timing <> 'unknown'
  ), 0))::numeric, 2) as late_or_poor_rate,
  count(*) filter (
    where status in ('qualified', 'near_qualified', 'hot_watch', 'watching', 'late_entry')
      and status <> 'executed'
      and result in ('win', 'loss', 'breakeven')
  )::integer as actionable_nonexecuted_outcomes,
  count(*) filter (
    where status in ('qualified', 'near_qualified', 'hot_watch', 'watching', 'late_entry')
      and status <> 'executed'
      and result = 'win'
  )::integer as missed_winners,
  round((100.0 * count(*) filter (
    where status in ('qualified', 'near_qualified', 'hot_watch', 'watching', 'late_entry')
      and status <> 'executed'
      and result = 'win'
  ) / nullif(count(*) filter (
    where status in ('qualified', 'near_qualified', 'hot_watch', 'watching', 'late_entry')
      and status <> 'executed'
      and result in ('win', 'loss')
  ), 0))::numeric, 2) as missed_winner_rate,
  round(avg(realized_r) filter (
    where status in ('qualified', 'near_qualified', 'hot_watch', 'watching', 'late_entry')
      and status <> 'executed'
      and result in ('win', 'loss', 'breakeven')
  )::numeric, 4) as actionable_nonexecuted_expectancy_r
from public.signal_outcome_dataset
where horizon_minutes = 60
group by user_id, broker_account_id, engine, pair, horizon_minutes;

-- Exact audit-to-trade attribution measures whether confidence adjustments that
-- reached execution aligned with true OANDA realized R. This is a trust check,
-- not an independent execution gate.
create or replace view public.engine_learning_adjustment_effectiveness_stats as
select
  lifecycle.user_id,
  lifecycle.broker_account_id,
  lifecycle.engine,
  lifecycle.pair,
  60::integer as horizon_minutes,
  min(lifecycle.opened_at) as evidence_start_at,
  max(coalesce(lifecycle.closed_at, lifecycle.opened_at)) as evidence_end_at,
  count(*) filter (
    where audit.combined_adjustment <> 0 and lifecycle.realized_r is not null
  )::integer as adjusted_outcomes,
  round(avg(audit.combined_adjustment) filter (
    where audit.combined_adjustment <> 0 and lifecycle.realized_r is not null
  )::numeric, 4) as average_applied_adjustment,
  round(avg(lifecycle.realized_r) filter (
    where audit.combined_adjustment <> 0 and lifecycle.realized_r is not null
  )::numeric, 4) as adjusted_expectancy_r,
  round((100.0 * avg(case
    when audit.combined_adjustment > 0 and lifecycle.realized_r > 0 then 1
    when audit.combined_adjustment < 0 and lifecycle.realized_r <= 0 then 1
    when audit.combined_adjustment <> 0 and lifecycle.realized_r is not null then 0
    else null
  end))::numeric, 2) as adjustment_alignment_rate
from public.actual_trade_lifecycles lifecycle
join public.engine_learning_adjustment_audit audit
  on audit.id = lifecycle.learning_audit_id
 and audit.broker_account_id = lifecycle.broker_account_id
 and audit.engine = lifecycle.engine
 and audit.pair = lifecycle.pair
where lifecycle.state = 'closed'
  and lifecycle.result in ('win', 'loss', 'breakeven')
group by lifecycle.user_id, lifecycle.broker_account_id, lifecycle.engine, lifecycle.pair;

revoke all on public.engine_signal_learning_stats from anon, authenticated;
revoke all on public.engine_learning_adjustment_effectiveness_stats from anon, authenticated;

comment on column public.actual_trade_lifecycles.learning_audit_id is
  'Exact confidence-calibration audit associated with the executed broker trade.';
comment on view public.engine_signal_learning_stats is
  '60-minute missed-winner and late/poor-entry evidence from all actionable market scans; hard rejects are excluded from missed opportunities.';
comment on view public.engine_learning_adjustment_effectiveness_stats is
  'Applied confidence adjustments evaluated against exact linked OANDA realized R.';
