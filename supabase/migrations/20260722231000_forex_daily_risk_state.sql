create table if not exists public.forex_daily_risk_state (
  account_id text not null,
  risk_date date not null,
  starting_balance numeric not null,
  last_observed_balance numeric not null,
  realized_pnl numeric not null default 0,
  recovery_trades_remaining integer not null default 0
    check (recovery_trades_remaining >= 0),
  last_loss_detected_at timestamptz,
  trading_locked boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (account_id, risk_date)
);

create index if not exists forex_daily_risk_state_latest_idx
  on public.forex_daily_risk_state (account_id, risk_date desc);

alter table public.forex_daily_risk_state enable row level security;

-- Railway reads and writes through the service-role key. Browser clients should
-- never be able to inspect or alter account-level risk locks directly.
revoke all on table public.forex_daily_risk_state from anon, authenticated;
grant all on table public.forex_daily_risk_state to service_role;

create or replace function public.set_forex_daily_risk_state_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists forex_daily_risk_state_updated_at on public.forex_daily_risk_state;
create trigger forex_daily_risk_state_updated_at
before update on public.forex_daily_risk_state
for each row execute function public.set_forex_daily_risk_state_updated_at();
