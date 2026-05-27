-- ============================================================================
-- 20260527000000_clerk_multi_tenant_init.sql
--
-- Multi-tenant foundation. Clerk owns identity; this schema stores the app
-- data keyed by Clerk's user_id (TEXT, since Clerk IDs are e.g. "user_2abc…").
--
-- All app code uses the service-role key and ALWAYS filters by user_id from
-- the authenticated session. RLS is enabled with deny-all policies as
-- defense-in-depth: even if a query reaches Postgres with the anon key (which
-- it should never), no row is exposed.
-- ============================================================================

-- ─── users ──────────────────────────────────────────────────────────────────
-- Shadow user table. One row per Clerk user, upserted on first dashboard
-- visit (see web/lib/users.ts). FK target for every other app table.
create table if not exists public.users (
    clerk_user_id   text primary key,
    email           text not null,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

create index if not exists users_email_idx on public.users (email);

-- ─── broker_connections ─────────────────────────────────────────────────────
-- Per-user credentials for connected broker accounts.
--
-- Credentials are AES-256-GCM encrypted by the app (web/lib/encryption.ts).
-- The DB only ever sees ciphertext. Format: <iv-hex>:<auth-tag-hex>:<ct-hex>.
--
-- A user may have multiple connections (e.g. an OANDA practice + an OANDA live
-- account). The UNIQUE constraint prevents duplicates of the exact same
-- (broker, account, environment) per user.
create table if not exists public.broker_connections (
    id                uuid primary key default gen_random_uuid(),
    user_id           text not null references public.users(clerk_user_id) on delete cascade,
    broker            text not null check (broker in ('oanda', 'alpaca')),
    account_id        text not null,
    environment       text not null check (environment in ('practice', 'live', 'paper')),
    encrypted_token   text not null,
    encrypted_secret  text,
    is_active         boolean not null default true,
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now(),
    unique (user_id, broker, account_id, environment)
);

create index if not exists broker_connections_user_idx
    on public.broker_connections (user_id) where is_active = true;

-- ─── RLS — deny-all defaults ────────────────────────────────────────────────
-- App code uses the service role and bypasses RLS. RLS is still enabled with
-- restrictive policies so that any *future* anon/auth-role access fails
-- closed. The day someone adds a Supabase JWT integration, these policies
-- become the load-bearing access check — better to have them in place now.
alter table public.users               enable row level security;
alter table public.broker_connections  enable row level security;

-- No anon/auth-role access. Service role still works (RLS doesn't apply).
drop policy if exists "users_deny_all"               on public.users;
drop policy if exists "broker_connections_deny_all"  on public.broker_connections;

create policy "users_deny_all"
    on public.users
    for all
    using (false)
    with check (false);

create policy "broker_connections_deny_all"
    on public.broker_connections
    for all
    using (false)
    with check (false);

-- ─── updated_at triggers ────────────────────────────────────────────────────
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists users_set_updated_at on public.users;
create trigger users_set_updated_at
    before update on public.users
    for each row execute function public.set_updated_at();

drop trigger if exists broker_connections_set_updated_at on public.broker_connections;
create trigger broker_connections_set_updated_at
    before update on public.broker_connections
    for each row execute function public.set_updated_at();
