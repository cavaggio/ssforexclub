-- ============================================================================
-- 20260609000000_user_trading_settings_auto_ai.sql
--
-- ICT Phase 1 — Auto AI Trading toggle.
--
-- ADDITIVE ONLY. Adds a single nullable-with-default boolean to
-- public.user_trading_settings so each user can opt in/out of AI auto-trading.
-- This is the per-user source of truth for the dashboard "Auto AI Trading"
-- toggle (the platform env flag PLATFORM_LIVE_TRADING_ENABLED is a separate
-- upper-level gate enforced at execution time).
--
--   * `add column if not exists ... default false` — idempotent, safe to re-run,
--   * every existing row defaults to FALSE (auto-trading OFF),
--   * does not touch RLS, the deny-all policy, indexes, or other columns.
-- ============================================================================

alter table public.user_trading_settings
  add column if not exists auto_ai_trading_enabled boolean not null default false;
