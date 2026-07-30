begin;

create table if not exists public.ftmo_client_connections (
  id uuid primary key default gen_random_uuid(),
  user_id text not null unique,
  account_login text not null,
  server text not null,
  bridge_url text not null,
  bridge_api_key_encrypted text not null,
  bridge_secret_encrypted text not null,
  terminal_id text not null default 'ftmo-demo-primary',
  environment text not null default 'free_trial',
  account_model text not null default 'demo',
  status text not null default 'saved',
  last_tested_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ftmo_client_connections_environment_check
    check (environment in ('free_trial','challenge','verification','funded')),
  constraint ftmo_client_connections_account_model_check
    check (account_model in ('demo','one_step','two_step','funded')),
  constraint ftmo_client_connections_status_check
    check (status in ('saved','connected','error','disabled'))
);

create index if not exists ftmo_client_connections_status_idx
  on public.ftmo_client_connections (status, updated_at desc);

alter table public.ftmo_client_connections enable row level security;

drop policy if exists "deny direct ftmo client connection access"
  on public.ftmo_client_connections;

create policy "deny direct ftmo client connection access"
  on public.ftmo_client_connections
  for all
  to anon, authenticated
  using (false)
  with check (false);

revoke all on table public.ftmo_client_connections from anon, authenticated;
grant all on table public.ftmo_client_connections to service_role;

comment on table public.ftmo_client_connections is
  'Per-client FTMO MT5 bridge settings. API keys and secrets are encrypted by the server before storage.';

commit;
