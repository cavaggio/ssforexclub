-- Make actual_trade_lifecycles the authoritative nightly OANDA reconciliation queue.
--
-- The previous reconcilable_oanda_trade_openings view rebuilt every opening from
-- trade_logs through to_jsonb(row), which became expensive enough to hit the
-- Supabase statement timeout during the 17:30 ET review. New trade opens are
-- already persisted directly into actual_trade_lifecycles by web/lib/tradeLogs.ts,
-- so the nightly job should read the indexed lifecycle queue instead.
--
-- This migration also keeps a bounded legacy repair source backed by first-class
-- trade_logs columns and seeds any recoverable historical openings that never made
-- it into actual_trade_lifecycles. It does not change trading or execution logic.

begin;

-- Fast lookup for the 17:30 ET queue. Open/unresolved rows remain eligible until
-- OANDA confirms the terminal state. A trade-log close remains eligible until its
-- exact OANDA trade detail has replaced the provisional close attribution.
create index if not exists actual_trade_lifecycles_reconciliation_queue_idx
  on public.actual_trade_lifecycles (user_id, broker_account_id, opened_at)
  where state in ('unresolved', 'open')
     or actual_outcome_source = 'trade_log_close_pending_oanda_reconciliation';

-- Fast bounded legacy repair path. The 20260717 attribution migration populated
-- engine and broker_trade_id as first-class columns, so repair no longer needs to
-- convert every trade_logs row to jsonb before it can filter by account/event.
create index if not exists trade_logs_oanda_open_repair_idx
  on public.trade_logs (user_id, broker_account_id, created_at desc)
  where broker = 'oanda'
    and event_type = 'opened'
    and broker_trade_id is not null;

create or replace view public.legacy_oanda_trade_openings_repair as
with normalized as (
  select
    t.id::text as trade_log_id,
    t.user_id,
    t.broker_account_id,
    coalesce(nullif(t.environment, ''), 'unknown') as environment,
    lower(coalesce(
      nullif(t.engine, ''),
      nullif(t.raw_payload ->> 'engine', ''),
      nullif(t.raw_payload #>> '{executed,engine}', ''),
      case
        when upper(coalesce(t.strategy, t.raw_payload ->> 'strategy', t.raw_payload #>> '{executed,strategy}', '')) = 'ICT' then 'ict'
        when upper(coalesce(t.strategy, t.raw_payload ->> 'strategy', t.raw_payload #>> '{executed,strategy}', '')) = 'PPR' then 'ppr'
        when upper(coalesce(t.strategy, t.raw_payload ->> 'strategy', t.raw_payload #>> '{executed,strategy}', '')) like 'V3%' then 'v3'
        else null
      end
    )) as engine,
    coalesce(
      nullif(t.broker_trade_id, ''),
      nullif(t.trade_id, ''),
      nullif(t.raw_payload ->> 'tradeId', ''),
      nullif(t.raw_payload ->> 'trade_id', ''),
      nullif(t.raw_payload #>> '{executed,tradeId}', ''),
      nullif(t.raw_payload #>> '{item,tradeId}', ''),
      nullif(t.raw_payload #>> '{result,tradeId}', '')
    ) as broker_trade_id,
    upper(replace(coalesce(
      nullif(t.instrument, ''),
      nullif(t.raw_payload #>> '{item,pair}', ''),
      nullif(t.raw_payload #>> '{result,pair}', ''),
      nullif(t.raw_payload #>> '{signal,pair}', '')
    ), '/', '_')) as pair,
    case
      when lower(coalesce(
        nullif(t.side, ''),
        nullif(t.raw_payload #>> '{item,direction}', ''),
        nullif(t.raw_payload #>> '{result,direction}', ''),
        nullif(t.raw_payload #>> '{signal,direction}', '')
      )) in ('long', 'buy', 'bullish') then 'long'
      when lower(coalesce(
        nullif(t.side, ''),
        nullif(t.raw_payload #>> '{item,direction}', ''),
        nullif(t.raw_payload #>> '{result,direction}', ''),
        nullif(t.raw_payload #>> '{signal,direction}', '')
      )) in ('short', 'sell', 'bearish') then 'short'
      else null
    end as direction,
    t.created_at as opened_at,
    t.entry_price,
    t.sl as stop_loss,
    t.tp as take_profit,
    t.units,
    case
      when coalesce(
        nullif(t.raw_payload #>> '{item,riskUSD}', ''),
        nullif(t.raw_payload #>> '{result,riskUSD}', ''),
        nullif(t.raw_payload #>> '{signal,targetRiskUSD}', '')
      ) ~ '^-?[0-9]+([.][0-9]+)?$'
      then coalesce(
        nullif(t.raw_payload #>> '{item,riskUSD}', ''),
        nullif(t.raw_payload #>> '{result,riskUSD}', ''),
        nullif(t.raw_payload #>> '{signal,targetRiskUSD}', '')
      )::numeric
      else null
    end as risk_usd,
    coalesce(t.raw_payload, '{}'::jsonb) as raw_payload
  from public.trade_logs t
  where t.broker = 'oanda'
    and t.event_type = 'opened'
)
select
  trade_log_id,
  user_id,
  broker_account_id,
  environment,
  engine,
  broker_trade_id,
  pair,
  direction,
  opened_at,
  entry_price,
  stop_loss,
  take_profit,
  units,
  risk_usd,
  raw_payload
from normalized
where user_id is not null
  and broker_account_id is not null
  and broker_trade_id is not null
  and engine in ('ict', 'ppr', 'v3');

comment on view public.legacy_oanda_trade_openings_repair is
  'Legacy-only repair source for OANDA openings missing from actual_trade_lifecycles. Not the nightly reconciliation queue.';

-- Recover any historical holes (including previously identified missing ICT
-- openings) without touching rows that already have richer lifecycle context.
insert into public.actual_trade_lifecycles (
  user_id,
  broker_account_id,
  environment,
  broker,
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
  reconciled_at,
  updated_at
)
select
  r.user_id,
  r.broker_account_id,
  r.environment,
  'oanda',
  r.engine,
  r.broker_trade_id,
  r.trade_log_id,
  r.pair,
  r.direction,
  r.opened_at,
  r.entry_price,
  r.units,
  r.stop_loss,
  r.take_profit,
  r.risk_usd,
  'unresolved',
  'unresolved',
  'trade_logs_direct_repair',
  'awaiting_oanda_trade_detail',
  coalesce(r.raw_payload, '{}'::jsonb),
  null,
  now()
from public.legacy_oanda_trade_openings_repair r
left join public.actual_trade_lifecycles l
  on l.user_id = r.user_id
 and l.broker_account_id = r.broker_account_id
 and l.broker_trade_id = r.broker_trade_id
where l.id is null
on conflict (user_id, broker_account_id, broker_trade_id) do nothing;

-- Preserve the existing application contract/name, but make the canonical
-- reconciliation view a cheap projection of actual_trade_lifecycles. The web
-- service can continue querying reconcilable_oanda_trade_openings unchanged.
create or replace view public.reconcilable_oanda_trade_openings as
select
  l.source_trade_log_id as trade_log_id,
  l.user_id,
  l.broker_account_id,
  l.environment,
  l.engine,
  l.broker_trade_id,
  l.pair,
  l.direction,
  l.opened_at,
  l.entry_price,
  l.stop_loss,
  l.take_profit,
  l.units,
  l.risk_usd,
  coalesce(l.opening_snapshot, '{}'::jsonb) as raw_payload
from public.actual_trade_lifecycles l
where l.state in ('unresolved', 'open')
   or l.actual_outcome_source = 'trade_log_close_pending_oanda_reconciliation';

comment on view public.reconcilable_oanda_trade_openings is
  'Authoritative indexed OANDA reconciliation queue backed by actual_trade_lifecycles. Legacy trade_logs reconstruction lives in legacy_oanda_trade_openings_repair.';

commit;
