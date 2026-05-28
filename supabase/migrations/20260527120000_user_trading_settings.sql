-- ============================================================================
-- 20260527120000_user_trading_settings.sql
--
-- Per-user trading-mode toggle. Companion to the existing broker_connections
-- table (from 20260527000000_clerk_multi_tenant_init.sql).
--
-- Why a separate table: a user may have multiple broker_connections (OANDA
-- practice + OANDA live + Alpaca paper). user_trading_settings stores WHICH
-- of those is currently active for the user, plus the one-time live-trading
-- acknowledgement flag.
-- ============================================================================

create table if not exists public.user_trading_settings (
    user_id                       text primary key references public.users(clerk_user_id) on delete cascade,
    -- 'oanda' | 'alpaca' — the broker the user is currently routing through.
    active_broker                 text check (active_broker in ('oanda', 'alpaca')),
    -- 'practice' | 'paper' | 'live'. May be set independently of an active
    -- connection so the UI can show "Live mode selected but no live OANDA
    -- credentials connected".
    active_environment            text check (active_environment in ('practice', 'paper', 'live')),
    -- FK to broker_connections. Nullable so a user can pick a mode before
    -- linking the matching credentials.
    active_broker_connection_id   uuid references public.broker_connections(id) on delete set null,
    -- One-time live-trading risk acknowledgement (Part 5 of the spec).
    -- Live cannot be activated until this is true.
    live_trading_acknowledged     boolean not null default false,
    live_trading_acknowledged_at  timestamptz,
    created_at                    timestamptz not null default now(),
    updated_at                    timestamptz not null default now()
);

create index if not exists user_trading_settings_active_conn_idx
    on public.user_trading_settings (active_broker_connection_id);

-- ─── RLS — deny-all defaults (same pattern as users / broker_connections) ──
alter table public.user_trading_settings enable row level security;

drop policy if exists "user_trading_settings_deny_all" on public.user_trading_settings;
create policy "user_trading_settings_deny_all"
    on public.user_trading_settings
    for all
    using (false)
    with check (false);

-- ─── updated_at trigger (re-uses the helper from the initial migration) ────
drop trigger if exists user_trading_settings_set_updated_at on public.user_trading_settings;
create trigger user_trading_settings_set_updated_at
    before update on public.user_trading_settings
    for each row execute function public.set_updated_at();
