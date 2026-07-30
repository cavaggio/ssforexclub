-- Finalize actual-account compatibility and keep forward evidence at 60 minutes only.

create or replace view public.engine_actual_account_accuracy_7d as
select
  user_id,
  broker_account_id,
  engine,
  count(distinct trading_date)::integer as trading_days,
  count(distinct pair)::integer as pairs_studied,
  min(opened_at) as evidence_start_at,
  max(coalesce(closed_at, opened_at)) as evidence_end_at,
  count(*)::integer as outcomes,
  count(*) filter (where result = 'win')::integer as wins,
  count(*) filter (where result = 'loss')::integer as losses,
  count(*) filter (where result = 'breakeven')::integer as breakevens,
  round((100.0 * count(*) filter (where result = 'win') /
    nullif(count(*) filter (where result in ('win', 'loss')), 0))::numeric, 2) as win_rate,
  round((avg(realized_r) filter (where realized_r is not null))::numeric, 4) as expectancy_r,
  round(sum(realized_pl)::numeric, 2) as total_realized_pl,
  round((sum(greatest(realized_pl, 0)) /
    nullif(abs(sum(least(realized_pl, 0))), 0))::numeric, 4) as profit_factor,
  count(*) filter (where realized_r is not null)::integer as r_outcomes,
  60::integer as horizon_minutes
from public.actual_trade_lifecycles_last_7_trading_days
group by user_id, broker_account_id, engine;

create or replace view public.engine_actual_account_pair_accuracy_7d as
select
  user_id,
  broker_account_id,
  engine,
  pair,
  60::integer as horizon_minutes,
  count(distinct trading_date)::integer as trading_days,
  min(opened_at) as evidence_start_at,
  max(coalesce(closed_at, opened_at)) as evidence_end_at,
  count(*)::integer as outcomes,
  count(*) filter (where result = 'win')::integer as wins,
  count(*) filter (where result = 'loss')::integer as losses,
  count(*) filter (where result = 'breakeven')::integer as breakevens,
  round((100.0 * count(*) filter (where result = 'win') /
    nullif(count(*) filter (where result in ('win', 'loss')), 0))::numeric, 2) as win_rate,
  round((avg(realized_r) filter (where realized_r is not null))::numeric, 4) as expectancy_r,
  round(sum(realized_pl)::numeric, 2) as total_realized_pl,
  round((sum(greatest(realized_pl, 0)) /
    nullif(abs(sum(least(realized_pl, 0))), 0))::numeric, 4) as profit_factor,
  count(*) filter (where realized_r is not null)::integer as r_outcomes
from public.actual_trade_lifecycles_last_7_trading_days
group by user_id, broker_account_id, engine, pair;

create or replace view public.engine_combined_pair_stats as
select
  coalesce(a.user_id, f.user_id) as user_id,
  coalesce(a.broker_account_id, f.broker_account_id) as broker_account_id,
  coalesce(a.engine, f.engine) as engine,
  coalesce(a.pair, f.pair) as pair,
  60::integer as horizon_minutes,
  coalesce(a.evidence_start_at, f.evidence_start_at) as evidence_start_at,
  coalesce(a.evidence_end_at, f.evidence_end_at) as evidence_end_at,
  coalesce(a.outcomes, f.outcomes, 0)::integer as outcomes,
  coalesce(a.wins, f.wins, 0)::integer as wins,
  coalesce(a.losses, f.losses, 0)::integer as losses,
  coalesce(a.win_rate, f.win_rate) as win_rate,
  coalesce(a.expectancy_r, f.expectancy_r) as expectancy_r,
  coalesce(a.profit_factor, f.profit_factor) as profit_factor,
  f.avg_mfe_r,
  f.avg_mae_r,
  f.direction_accuracy,
  f.target_rate,
  f.stop_rate,
  coalesce(a.outcomes, 0)::integer as actual_outcomes,
  coalesce(f.outcomes, 0)::integer as forward_outcomes,
  case when a.outcomes is not null then 'actual_trade_primary_forward_path_supplemental'
       else 'forward_path_only'
  end as evidence_source
from public.engine_actual_account_pair_accuracy_7d a
full join (
  select *
  from public.engine_executed_pair_stats
  where horizon_minutes = 60
) f
  on f.user_id = a.user_id
 and f.broker_account_id = a.broker_account_id
 and f.engine = a.engine
 and f.pair = a.pair;
