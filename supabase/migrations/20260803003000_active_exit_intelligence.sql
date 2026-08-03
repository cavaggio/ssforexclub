-- Active Exit Intelligence v1
--
-- Adds an independent per-user automatic exit-management toggle and durable
-- per-trade state. Auto-entry can be OFF while automatic management remains ON.
-- The state table prevents repeated partial closes and preserves peak-profit
-- context across Railway/Vercel restarts.

alter table public.user_trading_settings
  add column if not exists auto_close_enabled boolean not null default false;

create table if not exists public.trade_exit_management_state (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  broker_account_id text not null,
  trade_id text not null,
  instrument text,
  engine text not null default 'ict',
  partial_count integer not null default 0,
  cumulative_partial_percent numeric(6,2) not null default 0,
  peak_profit_r numeric(12,5),
  peak_profit_pips numeric(14,5),
  last_action text,
  last_action_at timestamptz,
  last_decision jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint trade_exit_management_state_partial_count_chk
    check (partial_count >= 0 and partial_count <= 2),
  constraint trade_exit_management_state_partial_percent_chk
    check (cumulative_partial_percent >= 0 and cumulative_partial_percent <= 100),
  constraint trade_exit_management_state_engine_chk
    check (engine in ('ict', 'v3', 'ppr')),
  unique (user_id, broker_account_id, trade_id)
);

create index if not exists trade_exit_management_state_user_idx
  on public.trade_exit_management_state (user_id, updated_at desc);

create index if not exists trade_exit_management_state_account_trade_idx
  on public.trade_exit_management_state (broker_account_id, trade_id);

alter table public.trade_exit_management_state enable row level security;

-- No browser policy is created. The table is intentionally service-role only;
-- every application query still pins both user_id and broker_account_id.
