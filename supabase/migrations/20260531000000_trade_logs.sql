-- ============================================================================
-- 20260531000000_trade_logs.sql
--
-- Per-user trade event log. Captures every meaningful trade-lifecycle event
-- the app produces — opens, closes (manual / partial / auto), reassessments,
-- TP/SL adjustments — so the dashboard can render history, P/L review,
-- analytics, and (eventually) compliance reports without ever reading
-- another user's trades.
--
-- Identity: user_id is the Clerk user_id (TEXT), matching the FK pattern from
-- the multi-tenant init migration. Service-role inserts; RLS deny-all by
-- default so any future anon/auth-role access fails closed.
--
-- The raw_payload column stores a JSONB of whatever the writer wants to keep
-- for debugging (full broker response, recommendation context, etc.). The app
-- helper sanitises this payload before insert — no apiKey/token/secret keys
-- are ever stored.
-- ============================================================================

create table if not exists public.trade_logs (
    id                uuid primary key default gen_random_uuid(),
    user_id           text not null references public.users(clerk_user_id) on delete cascade,
    organization_id   text,
    broker            text not null check (broker in ('oanda', 'alpaca')),
    broker_account_id text,
    environment       text not null check (environment in ('practice', 'live', 'paper')),
    instrument        text,
    trade_id          text,
    broker_order_id   text,
    event_type        text not null check (event_type in (
        'opened',
        'closed',
        'partial_closed',
        'tp_updated',
        'sl_updated',
        'reassessed',
        'auto_close_recommended',
        'manual_close_executed',
        'error'
    )),
    side              text check (side in ('long', 'short')),
    units             numeric,
    units_closed      numeric,
    entry_price       numeric,
    exit_price        numeric,
    realized_pl       numeric,
    unrealized_pl     numeric,
    tp                numeric,
    sl                numeric,
    recommendation    text,
    confidence        numeric,
    reason            text,
    raw_payload       jsonb,
    created_at        timestamptz not null default now()
);

-- ─── Indexes ────────────────────────────────────────────────────────────────
create index if not exists trade_logs_user_idx
    on public.trade_logs (user_id);
create index if not exists trade_logs_org_idx
    on public.trade_logs (organization_id);
create index if not exists trade_logs_trade_id_idx
    on public.trade_logs (trade_id);
create index if not exists trade_logs_instrument_idx
    on public.trade_logs (instrument);
create index if not exists trade_logs_event_type_idx
    on public.trade_logs (event_type);
create index if not exists trade_logs_created_at_idx
    on public.trade_logs (created_at desc);
create index if not exists trade_logs_broker_account_env_idx
    on public.trade_logs (broker_account_id, environment);
-- Hot-path: the dashboard's per-user "recent history" query.
create index if not exists trade_logs_user_created_at_idx
    on public.trade_logs (user_id, created_at desc);

-- ─── RLS deny-all defaults ──────────────────────────────────────────────────
-- Same pattern as broker_connections / users. The Next.js server queries with
-- the service-role key (which bypasses RLS) and always filters by user_id
-- from the authenticated Clerk session. Deny-all is defense-in-depth in case
-- a future code path ever reaches Postgres with the anon or auth role.
alter table public.trade_logs enable row level security;

drop policy if exists "trade_logs_deny_all" on public.trade_logs;
create policy "trade_logs_deny_all"
    on public.trade_logs
    for all
    using (false)
    with check (false);
