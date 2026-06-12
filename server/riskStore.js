/**
 * server/riskStore.js
 *
 * Supabase-backed durable store for the daily risk baseline (table
 * public.daily_risk_state). Uses the SERVICE_ROLE key — it runs server-side in
 * the scanner only and bypasses RLS, mirroring web/lib/db.ts.
 *
 * Exposes a small domain interface consumed by riskManager.js:
 *   load({ accountId, tradingDateKey })  → { startingBalance } | null
 *   upsert({ accountId, tradingDateKey, startingBalance, realizedDailyPnL,
 *            dailyLossLimit, conservativeMode, tradingLocked, lastUpdatedAt })
 *
 * createSupabaseRiskStore() returns null when SUPABASE_URL /
 * SUPABASE_SERVICE_ROLE_KEY are absent, so riskManager transparently falls back
 * to in-memory-only state (no crash, no behaviour change) where Supabase isn't
 * configured.
 */

import { createClient } from '@supabase/supabase-js';

const TABLE = 'daily_risk_state';

let _client = null;
function getClient() {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return null;
  _client = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: 'public' },
  });
  return _client;
}

/**
 * Build the durable risk store, or return null when Supabase isn't configured.
 * riskManager treats null as "in-memory only".
 */
export function createSupabaseRiskStore() {
  const supabase = getClient();
  if (!supabase) {
    console.log('[RISK STORE] Supabase not configured — daily risk baseline is in-memory only (will not survive restart).');
    return null;
  }
  console.log('[RISK STORE] Supabase daily-risk persistence enabled.');
  return {
    async load({ accountId, tradingDateKey }) {
      const { data, error } = await supabase
        .from(TABLE)
        .select('starting_balance')
        .eq('account_id', String(accountId ?? '__default__'))
        .eq('trading_date_key', tradingDateKey)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return null;
      const startingBalance = Number(data.starting_balance);
      return Number.isFinite(startingBalance) ? { startingBalance } : null;
    },
    async upsert(row) {
      const { error } = await supabase.from(TABLE).upsert(
        {
          account_id: String(row.accountId ?? '__default__'),
          trading_date_key: row.tradingDateKey,
          starting_balance: row.startingBalance,
          realized_daily_pnl: row.realizedDailyPnL ?? 0,
          daily_loss_limit: row.dailyLossLimit ?? 0,
          conservative_mode: !!row.conservativeMode,
          trading_locked: !!row.tradingLocked,
          last_updated_at: row.lastUpdatedAt ?? new Date().toISOString(),
        },
        { onConflict: 'account_id,trading_date_key' },
      );
      if (error) throw new Error(error.message);
    },
  };
}
