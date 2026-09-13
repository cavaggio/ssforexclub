alter table public.mt5_ea_terminals
  add column if not exists balance numeric,
  add column if not exists equity numeric,
  add column if not exists daily_starting_balance numeric,
  add column if not exists daily_loss_percent numeric,
  add column if not exists effective_risk_percent numeric,
  add column if not exists trading_locked boolean not null default false,
  add column if not exists reduced_risk boolean not null default false,
  add column if not exists risk_policy_version text;

comment on column public.mt5_ea_terminals.daily_loss_percent is
  'EA-reported equity drawdown from the New York trading-day starting balance.';
comment on column public.mt5_ea_terminals.effective_risk_percent is
  'EA-enforced per-trade risk cap: 1.0 normally, 0.5 after a Signal Stack stop-loss for the rest of the NY day.';
comment on column public.mt5_ea_terminals.trading_locked is
  'True when the EA has latched the 2% daily equity-loss lock for the current New York trading day.';
