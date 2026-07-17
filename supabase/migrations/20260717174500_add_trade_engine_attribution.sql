begin;

alter table if exists public.trade_logs
  add column if not exists engine text,
  add column if not exists strategy text,
  add column if not exists broker_trade_id text;

comment on column public.trade_logs.engine is
  'Execution engine that opened or managed the trade, for example legacy, v3, ict, or ppr.';
comment on column public.trade_logs.strategy is
  'Human-readable strategy attribution captured when the trade event is written.';
comment on column public.trade_logs.broker_trade_id is
  'Broker-native trade identifier. Multiple lifecycle events may share this value.';

-- Backfill from a legacy first-class trade_id column when that schema variant exists.
do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'trade_logs'
      and column_name = 'trade_id'
  ) then
    execute $sql$
      update public.trade_logs
      set broker_trade_id = coalesce(broker_trade_id, nullif(trade_id::text, ''))
      where broker_trade_id is null
    $sql$;
  end if;
end $$;

-- Backfill attribution from the sanitized raw payload used by current Auto AI logs.
do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'trade_logs'
      and column_name = 'raw_payload'
  ) then
    execute $sql$
      update public.trade_logs
      set
        engine = coalesce(
          nullif(lower(engine), ''),
          nullif(lower(raw_payload ->> 'engine'), ''),
          nullif(lower(raw_payload #>> '{executed,engine}'), ''),
          case
            when upper(coalesce(raw_payload ->> 'strategy', raw_payload #>> '{executed,strategy}', '')) = 'PPR' then 'ppr'
            when upper(coalesce(raw_payload ->> 'strategy', raw_payload #>> '{executed,strategy}', '')) = 'ICT' then 'ict'
            when upper(coalesce(raw_payload ->> 'strategy', raw_payload #>> '{executed,strategy}', '')) like 'V3%' then 'v3'
            else null
          end
        ),
        strategy = coalesce(
          nullif(strategy, ''),
          nullif(raw_payload ->> 'strategy', ''),
          nullif(raw_payload #>> '{executed,strategy}', ''),
          nullif(raw_payload #>> '{executed,signal,strategy}', '')
        ),
        broker_trade_id = coalesce(
          nullif(broker_trade_id, ''),
          nullif(raw_payload ->> 'tradeId', ''),
          nullif(raw_payload ->> 'trade_id', ''),
          nullif(raw_payload #>> '{executed,tradeId}', ''),
          nullif(raw_payload #>> '{item,tradeId}', ''),
          nullif(raw_payload #>> '{request,tradeId}', ''),
          nullif(raw_payload #>> '{result,tradeId}', '')
        )
      where engine is null
         or strategy is null
         or broker_trade_id is null
    $sql$;
  end if;
end $$;

-- Some production rows use payload rather than raw_payload. Backfill those too.
do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'trade_logs'
      and column_name = 'payload'
  ) then
    execute $sql$
      update public.trade_logs
      set
        engine = coalesce(
          nullif(lower(engine), ''),
          nullif(lower(payload ->> 'engine'), ''),
          case
            when upper(coalesce(payload ->> 'strategy', '')) = 'PPR' then 'ppr'
            when upper(coalesce(payload ->> 'strategy', '')) = 'ICT' then 'ict'
            when upper(coalesce(payload ->> 'strategy', '')) like 'V3%' then 'v3'
            else null
          end
        ),
        strategy = coalesce(nullif(strategy, ''), nullif(payload ->> 'strategy', '')),
        broker_trade_id = coalesce(
          nullif(broker_trade_id, ''),
          nullif(payload ->> 'broker_trade_id', ''),
          nullif(payload ->> 'trade_id', ''),
          nullif(payload ->> 'tradeId', '')
        )
      where engine is null
         or strategy is null
         or broker_trade_id is null
    $sql$;
  end if;
end $$;

update public.trade_logs
set engine = lower(engine)
where engine is not null;

create index if not exists trade_logs_user_engine_created_idx
  on public.trade_logs (user_id, engine, created_at desc)
  where engine is not null;

create index if not exists trade_logs_user_broker_trade_created_idx
  on public.trade_logs (user_id, broker_trade_id, created_at desc)
  where broker_trade_id is not null;

commit;
