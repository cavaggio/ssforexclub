-- Standalone FTMO indices engine persistence.
-- Safe to run repeatedly in Supabase SQL Editor.

create table if not exists public.ftmo_indices_signals (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  account_id text,
  symbol text not null,
  direction text,
  status text not null default 'scanned',
  confidence numeric(5,2),
  entry numeric,
  stop_loss numeric,
  take_profit numeric,
  risk_reward numeric(8,3),
  risk_percent numeric(8,4),
  rejection_reasons jsonb not null default '[]'::jsonb,
  concepts jsonb not null default '{}'::jsonb,
  broker_order jsonb,
  created_at timestamptz not null default now(),
  executed_at timestamptz,
  closed_at timestamptz
);

create index if not exists ftmo_indices_signals_user_created_idx
  on public.ftmo_indices_signals (user_id, created_at desc);
create index if not exists ftmo_indices_signals_account_status_idx
  on public.ftmo_indices_signals (account_id, status, created_at desc);

alter table public.ftmo_indices_signals enable row level security;

-- Server/service-role only. The dashboard should use authenticated API routes,
-- matching the existing tenant-guarded execution architecture.
drop policy if exists "deny direct ftmo indices signal access" on public.ftmo_indices_signals;
create policy "deny direct ftmo indices signal access"
  on public.ftmo_indices_signals
  for all
  to anon, authenticated
  using (false)
  with check (false);

create table if not exists public.ftmo_indices_daily_risk (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  account_id text not null,
  trading_date date not null,
  start_balance numeric not null,
  realized_pnl numeric not null default 0,
  floating_pnl numeric not null default 0,
  reserved_risk numeric not null default 0,
  trades_count integer not null default 0,
  consecutive_losses integer not null default 0,
  locked boolean not null default false,
  lock_reason text,
  updated_at timestamptz not null default now(),
  unique (user_id, account_id, trading_date)
);

alter table public.ftmo_indices_daily_risk enable row level security;
drop policy if exists "deny direct ftmo indices risk access" on public.ftmo_indices_daily_risk;
create policy "deny direct ftmo indices risk access"
  on public.ftmo_indices_daily_risk
  for all
  to anon, authenticated
  using (false)
  with check (false);
