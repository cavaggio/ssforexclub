create extension if not exists pgcrypto;

create table if not exists public.oanda_transaction_sync_state (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  broker_account_id text not null,
  environment text not null check (environment in ('practice', 'live', 'paper')),
  last_transaction_id text,
  last_synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, broker_account_id, environment)
);

alter table public.oanda_transaction_sync_state enable row level security;

create index if not exists idx_oanda_transaction_sync_state_user
  on public.oanda_transaction_sync_state(user_id);

create index if not exists idx_oanda_transaction_sync_state_account
  on public.oanda_transaction_sync_state(broker_account_id, environment);
