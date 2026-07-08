create extension if not exists pgcrypto;

create table if not exists public.trade_logs (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  created_at timestamptz not null default now()
);

alter table public.trade_logs add column if not exists organization_id uuid null;
alter table public.trade_logs add column if not exists broker text null;
alter table public.trade_logs add column if not exists broker_account_id text null;
alter table public.trade_logs add column if not exists environment text null;

alter table public.trade_logs add column if not exists event_type text null;
alter table public.trade_logs add column if not exists status text null;

alter table public.trade_logs add column if not exists pair text null;
alter table public.trade_logs add column if not exists instrument text null;
alter table public.trade_logs add column if not exists direction text null;
alter table public.trade_logs add column if not exists side text null;

alter table public.trade_logs add column if not exists trade_id text null;
alter table public.trade_logs add column if not exists broker_order_id text null;

alter table public.trade_logs add column if not exists units numeric null;
alter table public.trade_logs add column if not exists units_closed numeric null;

alter table public.trade_logs add column if not exists entry_price numeric null;
alter table public.trade_logs add column if not exists exit_price numeric null;
alter table public.trade_logs add column if not exists realized_pl numeric null;
alter table public.trade_logs add column if not exists unrealized_pl numeric null;

alter table public.trade_logs add column if not exists tp numeric null;
alter table public.trade_logs add column if not exists sl numeric null;

alter table public.trade_logs add column if not exists recommendation text null;
alter table public.trade_logs add column if not exists confidence numeric null;
alter table public.trade_logs add column if not exists reason text null;

alter table public.trade_logs add column if not exists payload jsonb null;
alter table public.trade_logs add column if not exists raw_payload jsonb null;

-- Edge Intelligence fields
alter table public.trade_logs add column if not exists entry_time timestamptz null;
alter table public.trade_logs add column if not exists exit_time timestamptz null;
alter table public.trade_logs add column if not exists pnl numeric null;
alter table public.trade_logs add column if not exists win_loss text null;
alter table public.trade_logs add column if not exists session text null;
alter table public.trade_logs add column if not exists spread numeric null;
alter table public.trade_logs add column if not exists signal_score numeric null;
alter table public.trade_logs add column if not exists trend text null;
alter table public.trade_logs add column if not exists volatility text null;
alter table public.trade_logs add column if not exists market_regime text null;
alter table public.trade_logs add column if not exists macro_bias text null;
alter table public.trade_logs add column if not exists macro_risk text null;

create index if not exists trade_logs_user_created_idx
  on public.trade_logs (user_id, created_at desc);

create index if not exists trade_logs_user_event_idx
  on public.trade_logs (user_id, event_type, created_at desc);

create index if not exists trade_logs_user_trade_idx
  on public.trade_logs (user_id, trade_id);
