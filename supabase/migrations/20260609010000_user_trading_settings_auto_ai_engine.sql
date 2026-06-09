-- ============================================================================
-- 20260609010000_user_trading_settings_auto_ai_engine.sql
--
-- Auto AI Trading engine selector (ICT or V3 — never both).
--
-- ADDITIVE ONLY. Adds a single text column with a default + CHECK constraint to
-- public.user_trading_settings. Mutual exclusivity is structural: there is ONE
-- engine field, so a user can only ever have one auto-trading engine selected.
--
--   * `add column if not exists ... default 'ict'` — idempotent, safe to re-run,
--   * existing rows default to 'ict' (auto-trading itself stays OFF via the
--     existing auto_ai_trading_enabled default false),
--   * CHECK (auto_ai_engine in ('ict','v3')) added guardedly (no error if re-run),
--   * does not touch RLS, the deny-all policy, indexes, or other columns.
-- ============================================================================

alter table public.user_trading_settings
  add column if not exists auto_ai_engine text not null default 'ict';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'user_trading_settings_auto_ai_engine_chk'
  ) then
    alter table public.user_trading_settings
      add constraint user_trading_settings_auto_ai_engine_chk
      check (auto_ai_engine in ('ict', 'v3'));
  end if;
end $$;
