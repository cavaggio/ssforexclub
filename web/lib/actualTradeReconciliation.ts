import 'server-only';

import { getServerSupabase } from './db';
import {
  getDecryptedBrokerCredentials,
  resolveBrokerBaseUrl,
} from './brokerConnections';
import { sanitizePayload } from './tradeLogs';
import { buildActualTradeLifecycleRow } from './actualTradeReconciliationCore.js';

type JsonRecord = Record<string, any>;

export type ActualTradeReconciliationResult = {
  ok: boolean;
  userId: string;
  brokerAccountId: string;
  openingsConsidered: number;
  tradesFetched: number;
  tradesUpserted: number;
  closedTrades: number;
  openTrades: number;
  wins: number;
  losses: number;
  breakevens: number;
  failures: Array<{ brokerTradeId: string; error: string }>;
  accountAccuracy: JsonRecord | null;
  pairAccuracy: JsonRecord[];
  migrationRequired?: boolean;
  error?: string;
};

const MISSING_CODES = new Set(['42P01', '42703', 'PGRST205', 'PGRST204']);

function messageOf(error: unknown): string {
  if (!error) return '';
  if (typeof error === 'object' && 'message' in error) {
    return String((error as { message?: unknown }).message || '');
  }
  return String(error);
}

function migrationMissing(error: unknown): boolean {
  const record = error && typeof error === 'object' ? error as { code?: string; message?: string } : {};
  return MISSING_CODES.has(String(record.code || '')) ||
    /actual_trade_lifecycles|reconcilable_oanda_trade_openings|engine_actual_account_accuracy_7d/i
      .test(String(record.message || error || ''));
}

async function oandaGetJson(baseUrl: string, token: string, path: string): Promise<JsonRecord> {
  const response = await fetch(`${String(baseUrl).replace(/\/$/, '')}${path}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    cache: 'no-store',
  });
  const text = await response.text();
  let json: JsonRecord = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!response.ok) {
    throw new Error(String(json.errorMessage || json.error || text || `OANDA HTTP ${response.status}`));
  }
  return json;
}

async function fetchOandaTradeDetail({
  baseUrl,
  token,
  accountId,
  brokerTradeId,
}: {
  baseUrl: string;
  token: string;
  accountId: string;
  brokerTradeId: string;
}): Promise<JsonRecord> {
  const json = await oandaGetJson(
    baseUrl,
    token,
    `/v3/accounts/${encodeURIComponent(accountId)}/trades/${encodeURIComponent(brokerTradeId)}`,
  );
  if (!json.trade || typeof json.trade !== 'object') {
    throw new Error('OANDA did not return a trade object.');
  }
  return json.trade as JsonRecord;
}

export async function reconcileActualTradesForAccount({
  userId,
  connectionId,
  brokerAccountId,
  calendarLookbackDays = 14,
  now = new Date(),
}: {
  userId: string;
  connectionId: string;
  brokerAccountId: string;
  calendarLookbackDays?: number;
  now?: Date;
}): Promise<ActualTradeReconciliationResult> {
  const baseResult: ActualTradeReconciliationResult = {
    ok: false,
    userId,
    brokerAccountId,
    openingsConsidered: 0,
    tradesFetched: 0,
    tradesUpserted: 0,
    closedTrades: 0,
    openTrades: 0,
    wins: 0,
    losses: 0,
    breakevens: 0,
    failures: [],
    accountAccuracy: null,
    pairAccuracy: [],
  };

  try {
    const credentials = await getDecryptedBrokerCredentials(userId, connectionId);
    if (!credentials || credentials.broker !== 'oanda' || credentials.accountId !== brokerAccountId) {
      return { ...baseResult, error: 'Active OANDA credentials were unavailable for this exact account connection.' };
    }
    const baseUrl = resolveBrokerBaseUrl(credentials.broker, credentials.environment);
    const cutoff = new Date(now.getTime() - Math.max(1, Math.min(60, calendarLookbackDays)) * 86_400_000).toISOString();
    const supabase = getServerSupabase();

    // Deliberately no current-watchlist filter: historical trades remain attributed
    // to the engine/account that actually opened them, including legacy ICT pairs.
    const { data: openingRows, error: openingError } = await supabase
      .from('reconcilable_oanda_trade_openings')
      .select('*')
      .eq('user_id', userId)
      .eq('broker_account_id', brokerAccountId)
      .gte('opened_at', cutoff)
      .lte('opened_at', now.toISOString())
      .order('opened_at', { ascending: true })
      .limit(5000);
    if (openingError) throw openingError;

    const openings = [...new Map(
      (openingRows || [])
        .filter((row) => row.broker_trade_id && row.engine)
        .map((row) => [String(row.broker_trade_id), row as JsonRecord]),
    ).values()];
    baseResult.openingsConsidered = openings.length;

    const lifecycleRows: JsonRecord[] = [];
    for (const opening of openings) {
      const brokerTradeId = String(opening.broker_trade_id);
      try {
        const trade = await fetchOandaTradeDetail({
          baseUrl,
          token: credentials.token,
          accountId: brokerAccountId,
          brokerTradeId,
        });
        baseResult.tradesFetched += 1;
        const row = buildActualTradeLifecycleRow({ opening, trade, reconciledAt: now }) as JsonRecord;
        row.opening_snapshot = sanitizePayload(row.opening_snapshot);
        row.broker_snapshot = sanitizePayload(row.broker_snapshot);
        lifecycleRows.push(row);
      } catch (error) {
        baseResult.failures.push({ brokerTradeId, error: messageOf(error) });
      }
    }

    if (lifecycleRows.length) {
      const { error } = await supabase
        .from('actual_trade_lifecycles')
        .upsert(lifecycleRows, { onConflict: 'user_id,broker_account_id,broker_trade_id' });
      if (error) throw error;
    }
    baseResult.tradesUpserted = lifecycleRows.length;
    baseResult.closedTrades = lifecycleRows.filter((row) => row.state === 'closed').length;
    baseResult.openTrades = lifecycleRows.filter((row) => row.state === 'open').length;
    baseResult.wins = lifecycleRows.filter((row) => row.result === 'win').length;
    baseResult.losses = lifecycleRows.filter((row) => row.result === 'loss').length;
    baseResult.breakevens = lifecycleRows.filter((row) => row.result === 'breakeven').length;

    const [{ data: accountRows, error: accountError }, { data: pairRows, error: pairError }] = await Promise.all([
      supabase
        .from('engine_actual_account_accuracy_7d')
        .select('*')
        .eq('user_id', userId)
        .eq('broker_account_id', brokerAccountId)
        .order('engine', { ascending: true }),
      supabase
        .from('engine_actual_account_pair_accuracy_7d')
        .select('*')
        .eq('user_id', userId)
        .eq('broker_account_id', brokerAccountId)
        .order('engine', { ascending: true })
        .order('pair', { ascending: true }),
    ]);
    if (accountError) throw accountError;
    if (pairError) throw pairError;

    const actualAccountRows = Array.isArray(accountRows) ? accountRows : [];
    const actualPairRows = Array.isArray(pairRows) ? pairRows : [];
    return {
      ...baseResult,
      ok: baseResult.failures.length === 0,
      accountAccuracy: { rows: actualAccountRows },
      pairAccuracy: actualPairRows,
      error: baseResult.failures.length ? `${baseResult.failures.length} OANDA trade detail request(s) failed.` : undefined,
    };
  } catch (error) {
    return {
      ...baseResult,
      error: messageOf(error),
      migrationRequired: migrationMissing(error),
    };
  }
}
