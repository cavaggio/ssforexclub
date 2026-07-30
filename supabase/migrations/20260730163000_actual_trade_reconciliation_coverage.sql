-- Coverage audit for every recoverable bot opening.
-- This proves historical trades are attributed and studied rather than omitted.

create or replace view public.actual_trade_reconciliation_coverage as
select
  user_id,
  broker_account_id,
  engine,
  count(*)::integer as historical_openings,
  count(*) filter (where state = 'closed')::integer as closed_trades,
  count(*) filter (where state = 'open')::integer as open_trades,
  count(*) filter (where state = 'unresolved')::integer as unresolved_trades,
  count(*) filter (where result = 'win')::integer as wins,
  count(*) filter (where result = 'loss')::integer as losses,
  count(*) filter (where result = 'breakeven')::integer as breakevens,
  count(*) filter (where realized_pl is not null)::integer as trades_with_actual_pnl,
  count(*) filter (where realized_r is not null)::integer as trades_with_realized_r,
  count(distinct pair)::integer as pairs_studied,
  min(opened_at) as first_opened_at,
  max(opened_at) as latest_opened_at,
  bool_and(state in ('open', 'closed')) as every_opening_reconciled,
  bool_and(
    state = 'open'
    or (
      state = 'closed'
      and result in ('win', 'loss', 'breakeven')
      and realized_pl is not null
    )
  ) as every_closed_trade_studied
from public.actual_trade_lifecycles
group by user_id, broker_account_id, engine;

create or replace view public.actual_trade_reconciliation_pair_coverage as
select
  user_id,
  broker_account_id,
  engine,
  pair,
  count(*)::integer as historical_openings,
  count(*) filter (where state = 'closed')::integer as closed_trades,
  count(*) filter (where state = 'open')::integer as open_trades,
  count(*) filter (where state = 'unresolved')::integer as unresolved_trades,
  count(*) filter (where result = 'win')::integer as wins,
  count(*) filter (where result = 'loss')::integer as losses,
  count(*) filter (where result = 'breakeven')::integer as breakevens,
  min(opened_at) as first_opened_at,
  max(opened_at) as latest_opened_at
from public.actual_trade_lifecycles
group by user_id, broker_account_id, engine, pair;

revoke all on public.actual_trade_reconciliation_coverage from anon, authenticated;
revoke all on public.actual_trade_reconciliation_pair_coverage from anon, authenticated;

comment on view public.actual_trade_reconciliation_coverage is
  'Per account and originating engine proof that every recoverable opening is reconciled and every closed trade has an actual broker outcome.';
comment on view public.actual_trade_reconciliation_pair_coverage is
  'Per account, originating engine, and historical pair reconciliation coverage, including legacy pairs no longer eligible for execution.';
