begin;

create table if not exists public.mt5_ea_terminals (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  account_login text not null,
  server text not null,
  terminal_id text not null,
  token_hash text not null,
  status text not null default 'pending' check (status in ('pending','connected','stale','disabled')),
  last_heartbeat_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, account_login, terminal_id)
);

create unique index if not exists mt5_ea_terminals_lookup_idx
  on public.mt5_ea_terminals(account_login, terminal_id);

create table if not exists public.mt5_ea_commands (
  id uuid primary key default gen_random_uuid(),
  account_login text not null,
  terminal_id text not null,
  command_type text not null,
  payload jsonb not null default '{}'::jsonb,
  idempotency_key text not null unique,
  status text not null default 'pending' check (status in ('pending','claimed','completed','failed','expired')),
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz not null default (now() + interval '2 minutes'),
  result jsonb,
  error text
);

create index if not exists mt5_ea_commands_poll_idx
  on public.mt5_ea_commands(account_login, terminal_id, status, created_at);

alter table public.mt5_ea_terminals enable row level security;
alter table public.mt5_ea_commands enable row level security;

-- Service-role only. Browser clients never read bridge credentials or command queues.
revoke all on public.mt5_ea_terminals from anon, authenticated;
revoke all on public.mt5_ea_commands from anon, authenticated;

grant all on public.mt5_ea_terminals to service_role;
grant all on public.mt5_ea_commands to service_role;

commit;
