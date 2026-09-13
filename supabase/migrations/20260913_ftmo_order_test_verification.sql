alter table public.mt5_ea_terminals
  add column if not exists order_test_verified_at timestamptz,
  add column if not exists order_test_command_id uuid;

comment on column public.mt5_ea_terminals.order_test_verified_at is
  'Set only after the MT5 EA reports a successful explicit minimum-volume FTMO order test.';
