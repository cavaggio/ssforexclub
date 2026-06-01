-- ============================================================================
-- 20260531120000_trade_logs_edge_snapshot.sql
--
-- Signal Stack V3 — Edge Intelligence.
--
-- ADDITIVE ONLY. Adds nullable columns to public.trade_logs so each closed
-- trade can carry an "edge snapshot" — the conditions under which the trade was
-- taken — for historical edge analysis and strategy attribution.
--
-- Every column is `add column if not exists ... <type> null`, so this migration:
--   * never drops, renames, or retypes an existing column,
--   * is idempotent (safe to re-run),
--   * leaves all existing rows valid (every new column defaults to NULL),
--   * does not touch RLS, indexes already in place, or the deny-all policy.
--
-- `confidence` already exists on the table; `if not exists` makes its inclusion
-- here a harmless no-op so the full V3 snapshot field list is documented in one
-- place.
-- ============================================================================

alter table public.trade_logs add column if not exists pair          text;
alter table public.trade_logs add column if not exists direction     text;
alter table public.trade_logs add column if not exists entry_time     timestamptz;
alter table public.trade_logs add column if not exists exit_time      timestamptz;
alter table public.trade_logs add column if not exists pnl           numeric;
alter table public.trade_logs add column if not exists win_loss      text;
alter table public.trade_logs add column if not exists session       text;
alter table public.trade_logs add column if not exists spread        numeric;
alter table public.trade_logs add column if not exists confidence    numeric;
alter table public.trade_logs add column if not exists signal_score  numeric;
alter table public.trade_logs add column if not exists trend         text;
alter table public.trade_logs add column if not exists volatility    text;
alter table public.trade_logs add column if not exists market_regime text;
alter table public.trade_logs add column if not exists macro_bias    text;
alter table public.trade_logs add column if not exists macro_risk    text;

-- Helpful (optional) indexes for the Edge Intelligence dashboard aggregations.
-- All guarded by `if not exists`; none are unique, none constrain writes.
create index if not exists trade_logs_pair_idx          on public.trade_logs (pair);
create index if not exists trade_logs_session_idx       on public.trade_logs (session);
create index if not exists trade_logs_market_regime_idx on public.trade_logs (market_regime);
create index if not exists trade_logs_win_loss_idx      on public.trade_logs (win_loss);
