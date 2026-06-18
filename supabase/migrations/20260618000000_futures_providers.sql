-- ============================================================================
-- 20260618000000_futures_providers.sql
--
-- Adds NinjaTrader (futures) and Topstep (prop-firm) as broker providers.
--
-- These providers reuse the existing broker_connections + user_trading_settings
-- tables and the same AES-256-GCM encryption pattern. Unlike OANDA (single
-- token), these providers carry a multi-field credential object — the whole
-- object is JSON-encoded and stored AES-256-GCM-encrypted in `encrypted_token`
-- (the column already only ever holds ciphertext). `encrypted_secret` stays
-- null for these providers.
--
-- New environment values:
--   'sim'        — NinjaTrader simulated / paper
--   'evaluation' — Topstep evaluation / combine account (sim funds)
--   'funded'     — Topstep funded account (real funds)
-- ('live' is reused for a NinjaTrader live brokerage account.)
--
-- New metadata columns capture connector validation state for the dashboard.
-- ============================================================================

-- ─── broker_connections: widen provider + environment, add validation meta ──
alter table public.broker_connections
    drop constraint if exists broker_connections_broker_check;
alter table public.broker_connections
    add constraint broker_connections_broker_check
    check (broker in ('oanda', 'alpaca', 'ninjatrader', 'topstep'));

alter table public.broker_connections
    drop constraint if exists broker_connections_environment_check;
alter table public.broker_connections
    add constraint broker_connections_environment_check
    check (environment in ('practice', 'live', 'paper', 'sim', 'evaluation', 'funded'));

alter table public.broker_connections
    add column if not exists account_mode      text,           -- free-form provider account label (e.g. 'sim', 'funded')
    add column if not exists validation_status text not null default 'unvalidated'
        check (validation_status in ('unvalidated', 'valid', 'invalid')),
    add column if not exists last_validated_at timestamptz;

-- ─── user_trading_settings: allow selecting the new providers ───────────────
alter table public.user_trading_settings
    drop constraint if exists user_trading_settings_active_broker_check;
alter table public.user_trading_settings
    add constraint user_trading_settings_active_broker_check
    check (active_broker in ('oanda', 'alpaca', 'ninjatrader', 'topstep'));

alter table public.user_trading_settings
    drop constraint if exists user_trading_settings_active_environment_check;
alter table public.user_trading_settings
    add constraint user_trading_settings_active_environment_check
    check (active_environment in ('practice', 'paper', 'live', 'sim', 'evaluation', 'funded'));

-- RLS already enabled + deny-all on both tables (see initial migration); the
-- new columns inherit those policies. Service role continues to bypass RLS.
