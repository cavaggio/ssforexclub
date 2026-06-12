-- ============================================================================
-- 20260611000000_daily_risk_state.sql
--
-- Durable per-broker-account daily risk baseline so the 2.8% daily-loss lock
-- (and 1.4% conservative-mode trigger) survive a server/Railway restart.
--
-- Without this, dailyStartingBalance lived only in the scanner's memory: a
-- mid-day restart would re-anchor the baseline to the (lower) current balance
-- and silently reset the day's loss budget. This table stores the true
-- start-of-day balance, keyed by (account_id, trading_date_key) where the
-- date key follows the existing NY-midnight reset logic.
--
-- account_id is the broker (OANDA) account id — NOT a Clerk user id — because
-- risk is enforced per broker account in the scanner. Written only by the
-- service-role client (RLS denies everything else), same pattern as the other
-- backend tables.
-- ============================================================================

create table if not exists public.daily_risk_state (
    account_id            text not null,
    -- NY-local trading day, 'YYYY-MM-DD' (matches riskManager.nyDateKey()).
    trading_date_key      text not null,
    -- True start-of-day balance — set once on the first check of the day and
    -- never re-anchored intraday (this is the whole point of persisting it).
    starting_balance      numeric not null,
    realized_daily_pnl    numeric not null default 0,
    daily_loss_limit      numeric not null default 0,
    conservative_mode     boolean not null default false,
    trading_locked        boolean not null default false,
    created_at            timestamptz not null default now(),
    last_updated_at       timestamptz not null default now(),
    primary key (account_id, trading_date_key)
);

create index if not exists daily_risk_state_date_idx
    on public.daily_risk_state (trading_date_key);

-- ─── RLS — deny-all defaults (service role bypasses; same as other tables) ──
alter table public.daily_risk_state enable row level security;

drop policy if exists "daily_risk_state_deny_all" on public.daily_risk_state;
create policy "daily_risk_state_deny_all"
    on public.daily_risk_state
    for all
    using (false)
    with check (false);
