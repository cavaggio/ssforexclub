-- Actual OANDA trade lifecycle reconciliation.
-- Real broker wins/losses are the source of truth; 15/30/60/120-minute
-- forward-price studies remain a separate execution-quality evidence layer.

create extension if not exists pgcrypto;

create table if not exists public.actual_trade_lifecycles (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  broker_account_id text not null,
  environment text not null default 'unknown',
  broker text not null default 'oanda' check (broker = 'oanda'),
  engine text not null check (engine in ('ict', 'ppr', 'v3')),
  broker_trade_id text not null,
  source_trade_log_id text,
  pair text,
  direction text check (direction in ('long', 'short')),
  opened_at timestamptz,
  closed_at timestamptz,
  state text not null default 'unresolved' check (state in ('unresolved', 'open', 'closed')),
  result text not null default 'unresolved' check (result in ('unresolved', 'open', 'win', 'loss', 'breakeven')),
  entry_price numeric,
  exit_price numeric,
  units numeric,
  stop_loss numeric,
  take_profit numeric,
  risk_usd numeric,
  realized_pl numeric,
  realized_r numeric,
  opening_transaction_ids jsonb not null default '[]'::jsonb,
  closing_transaction_ids jsonb not null default '[]'::jsonb,
  engine_attribution_source text not null default 'trade_log_open',
  actual_outcome_source text,
  opening_snapshot jsonb not null default '{}'::jsonb,
  broker_snapshot jsonb not null default '{}'::jsonb,
  reconciled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, broker_account_id, broker_trade_id)
);

create index if not exists actual_trade_lifecycles_scope_idx
  on public.actual_trade_lifecycles
  (user_id, broker_account_id, engine, opened_at desc);

create index if not exists actual_trade_lifecycles_unresolved_idx
  on public.actual_trade_lifecycles
  (user_id, broker_account_id, state, opened_at)
  where state in ('unresolved', 'open');

-- Use to_jsonb(row) throughout so this view remains compatible with production
-- trade_logs variants while still recovering the canonical account/engine/trade ID.
create or replace view public.reconcilable_oanda_trade_openings as
with source as (
  select to_jsonb(t) as row_json
  from public.trade_logs t
), opened as (
  select
    row_json,
    coalesce(row_json -> 'payload', '{}'::jsonb) as payload,
    coalesce(row_json -> 'raw_payload', '{}'::jsonb) as raw_payload
  from source
  where lower(coalesce(row_json ->> 'event_type', row_json ->> 'type', '')) = 'opened'
), extracted as (
  select
    nullif(row_json ->> 'id', '') as trade_log_id,
    nullif(row_json ->> 'user_id', '') as user_id,
    coalesce(
      nullif(row_json ->> 'broker_account_id', ''),
      nullif(payload ->> 'broker_account_id', ''),
      nullif(raw_payload ->> 'broker_account_id', ''),
      nullif(raw_payload #>> '{item,accountId}', ''),
      nullif(raw_payload #>> '{item,accountID}', ''),
      nullif(raw_payload #>> '{result,accountId}', '')
    ) as broker_account_id,
    coalesce(
      nullif(row_json ->> 'environment', ''),
      nullif(payload ->> 'environment', ''),
      nullif(raw_payload ->> 'environment', ''),
      'unknown'
    ) as environment,
    lower(coalesce(
      nullif(raw_payload ->> 'engine', ''),
      nullif(raw_payload #>> '{item,strategy}', ''),
      nullif(raw_payload #>> '{signal,engine}', ''),
      nullif(raw_payload #>> '{result,engine}', ''),
      nullif(payload ->> 'engine', '')
    )) as engine,
    coalesce(
      nullif(row_json ->> 'trade_id', ''),
      nullif(raw_payload #>> '{item,tradeId}', ''),
      nullif(raw_payload #>> '{result,tradeId}', ''),
      nullif(payload ->> 'trade_id', '')
    ) as broker_trade_id,
    upper(replace(coalesce(
      nullif(row_json ->> 'pair', ''),
      nullif(row_json ->> 'instrument', ''),
      nullif(raw_payload #>> '{item,pair}', ''),
      nullif(raw_payload #>> '{result,pair}', ''),
      nullif(raw_payload #>> '{signal,pair}', '')
    ), '/', '_')) as pair,
    lower(coalesce(
      nullif(row_json ->> 'direction', ''),
      nullif(row_json ->> 'side', ''),
      nullif(raw_payload #>> '{item,direction}', ''),
      nullif(raw_payload #>> '{result,direction}', ''),
      nullif(raw_payload #>> '{signal,direction}', '')
    )) as direction,
    nullif(row_json ->> 'created_at', '')::timestamptz as opened_at,
    coalesce(
      nullif(row_json ->> 'entry_price', ''),
      nullif(raw_payload #>> '{item,fillPrice}', ''),
      nullif(raw_payload #>> '{result,fillPrice}', ''),
      nullif(raw_payload #>> '{signal,entry}', '')
    ) as entry_text,
    coalesce(
      nullif(row_json ->> 'sl', ''),
      nullif(raw_payload #>> '{item,stopLoss}', ''),
      nullif(raw_payload #>> '{result,stopLoss}', ''),
      nullif(raw_payload #>> '{signal,stopLoss}', '')
    ) as stop_text,
    coalesce(
      nullif(row_json ->> 'tp', ''),
      nullif(raw_payload #>> '{item,takeProfit}', ''),
      nullif(raw_payload #>> '{result,takeProfit}', ''),
      nullif(raw_payload #>> '{signal,target1}', '')
    ) as target_text,
    coalesce(
      nullif(row_json ->> 'units', ''),
      nullif(raw_payload #>> '{item,units}', ''),
      nullif(raw_payload #>> '{result,units}', '')
    ) as units_text,
    coalesce(
      nullif(raw_payload #>> '{item,riskUSD}', ''),
      nullif(raw_payload #>> '{result,riskUSD}', ''),
      nullif(raw_payload #>> '{signal,targetRiskUSD}', '')
    ) as risk_text,
    raw_payload
  from opened
)
select
  trade_log_id,
  user_id,
  broker_account_id,
  environment,
  engine,
  broker_trade_id,
  pair,
  case
    when direction in ('long', 'buy', 'bullish') then 'long'
    when direction in ('short', 'sell', 'bearish') then 'short'
    else null
  end as direction,
  opened_at,
  case when entry_text ~ '^-?[0-9]+([.][0-9]+)?$' then entry_text::numeric end as entry_price,
  case when stop_text ~ '^-?[0-9]+([.][0-9]+)?$' then stop_text::numeric end as stop_loss,
  case when target_text ~ '^-?[0-9]+([.][0-9]+)?$' then target_text::numeric end as take_profit,
  case when units_text ~ '^-?[0-9]+([.][0-9]+)?$' then units_text::numeric end as units,
  case when risk_text ~ '^-?[0-9]+([.][0-9]+)?$' then risk_text::numeric end as risk_usd,
  raw_payload
from extracted
where user_id is not null
  and broker_account_id is not null
  and broker_trade_id is not null
  and engine in ('ict', 'ppr', 'v3');

-- Seed every recoverable opening immediately. OANDA reconciliation subsequently
-- fills actual state, close, P&L, and R without changing engine/account attribution.
insert into public.actual_trade_lifecycles (
  user_id,
  broker_account_id,
  environment,
  engine,
  broker_trade_id,
  source_trade_log_id,
  pair,
  direction,
  opened_at,
  entry_price,
  units,
  stop_loss,
  take_profit,
  risk_usd,
  state,
  result,
  engine_attribution_source,
  actual_outcome_source,
  opening_snapshot,
  updated_at
)
select
  user_id,
  broker_account_id,
  environment,
  engine,
  broker_trade_id,
  trade_log_id,
  pair,
  direction,
  opened_at,
  entry_price,
  units,
  stop_loss,
  take_profit,
  risk_usd,
  'unresolved',
  'unresolved',
  'trade_log_open',
  'awaiting_oanda_trade_detail',
  coalesce(raw_payload, '{}'::jsonb),
  now()
from public.reconcilable_oanda_trade_openings
on conflict (user_id, broker_account_id, broker_trade_id) do update set
  engine = excluded.engine,
  source_trade_log_id = coalesce(actual_trade_lifecycles.source_trade_log_id, excluded.source_trade_log_id),
  pair = coalesce(actual_trade_lifecycles.pair, excluded.pair),
  direction = coalesce(actual_trade_lifecycles.direction, excluded.direction),
  opened_at = coalesce(actual_trade_lifecycles.opened_at, excluded.opened_at),
  entry_price = coalesce(actual_trade_lifecycles.entry_price, excluded.entry_price),
  units = coalesce(actual_trade_lifecycles.units, excluded.units),
  stop_loss = coalesce(actual_trade_lifecycles.stop_loss, excluded.stop_loss),
  take_profit = coalesce(actual_trade_lifecycles.take_profit, excluded.take_profit),
  risk_usd = coalesce(actual_trade_lifecycles.risk_usd, excluded.risk_usd),
  opening_snapshot = case
    when actual_trade_lifecycles.opening_snapshot = '{}'::jsonb then excluded.opening_snapshot
    else actual_trade_lifecycles.opening_snapshot
  end,
  updated_at = now();

create or replace view public.actual_trade_lifecycles_last_7_trading_days as
with distinct_days as (
  select distinct user_id, broker_account_id, engine, (opened_at at time zone 'America/New_York')::date as trading_date
  from public.actual_trade_lifecycles
  where state = 'closed'
    and result in ('win', 'loss', 'breakeven')
    and opened_at is not null
), ranked as (
  select
    user_id,
    broker_account_id,
    engine,
    trading_date,
    dense_rank() over (
      partition by user_id, broker_account_id, engine
      order by trading_date desc
    ) as trading_day_rank
  from distinct_days
)
select l.*, r.trading_date, r.trading_day_rank
from public.actual_trade_lifecycles l
join ranked r
  on r.user_id = l.user_id
 and r.broker_account_id = l.broker_account_id
 and r.engine = l.engine
 and r.trading_date = (l.opened_at at time zone 'America/New_York')::date
where r.trading_day_rank <= 7
  and l.state = 'closed'
  and l.result in ('win', 'loss', 'breakeven');

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
  round(avg(realized_r) filter (where realized_r is not null)::numeric, 4) as expectancy_r,
  round(sum(realized_pl)::numeric, 2) as total_realized_pl,
  round((sum(greatest(realized_pl, 0)) /
    nullif(abs(sum(least(realized_pl, 0))), 0))::numeric, 4) as profit_factor,
  count(*) filter (where realized_r is not null)::integer as r_outcomes
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
  round(avg(realized_r) filter (where realized_r is not null)::numeric, 4) as expectancy_r,
  round(sum(realized_pl)::numeric, 2) as total_realized_pl,
  round((sum(greatest(realized_pl, 0)) /
    nullif(abs(sum(least(realized_pl, 0))), 0))::numeric, 4) as profit_factor,
  count(*) filter (where realized_r is not null)::integer as r_outcomes
from public.actual_trade_lifecycles_last_7_trading_days
group by user_id, broker_account_id, engine, pair;

-- Actual trade results own win/loss/expectancy. Forward 60-minute evidence remains
-- available for MFE, MAE, target/stop behavior, context, and confirmation quality.
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
full join public.engine_executed_pair_stats f
  on f.user_id = a.user_id
 and f.broker_account_id = a.broker_account_id
 and f.engine = a.engine
 and f.pair = a.pair
 and f.horizon_minutes = 60;

alter table public.engine_learning_backfill_runs
  add column if not exists actual_openings_considered integer not null default 0,
  add column if not exists actual_trades_fetched integer not null default 0,
  add column if not exists actual_trades_upserted integer not null default 0,
  add column if not exists actual_closed_trades integer not null default 0;

alter table public.actual_trade_lifecycles enable row level security;
revoke all on public.actual_trade_lifecycles from anon, authenticated;
revoke all on public.reconcilable_oanda_trade_openings from anon, authenticated;
revoke all on public.actual_trade_lifecycles_last_7_trading_days from anon, authenticated;
revoke all on public.engine_actual_account_accuracy_7d from anon, authenticated;
revoke all on public.engine_actual_account_pair_accuracy_7d from anon, authenticated;
revoke all on public.engine_combined_pair_stats from anon, authenticated;

comment on table public.actual_trade_lifecycles is
  'Immutable account/engine attribution with actual OANDA trade state and outcome. Forward-price studies remain separate.';
comment on view public.reconcilable_oanda_trade_openings is
  'Every recoverable bot opening keyed by user, broker account, originating engine, and OANDA trade ID; no current-watchlist filter.';
comment on view public.engine_combined_pair_stats is
  'Actual broker outcomes are primary; forward 60-minute path statistics supplement execution-quality learning without double counting.';
