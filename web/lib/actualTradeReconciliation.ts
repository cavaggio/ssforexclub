import 'server-only';

import { getServerSupabase } from './db';
import {
  getDecryptedBrokerCredentials,
  resolveBrokerBaseUrl,
} from './brokerConnections';
import { sanitizePayload } from './tradeLogs';
import { buildActualTradeLifecycleRow, computeTradeExcursion } from './actualTradeReconciliationCore.js';

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
  learningAdjustmentsApplied: number;
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

async function fetchClosingTransactions({
  baseUrl,
  token,
  accountId,
  transactionIds,
}: {
  baseUrl: string;
  token: string;
  accountId: string;
  transactionIds: unknown;
}): Promise<JsonRecord[]> {
  const ids = Array.isArray(transactionIds) ? transactionIds.map(String).filter(Boolean) : [];
  return Promise.all(ids.slice(0, 20).map(async (id) => {
    const json = await oandaGetJson(
      baseUrl,
      token,
      `/v3/accounts/${encodeURIComponent(accountId)}/transactions/${encodeURIComponent(id)}`,
    );
    return (json.transaction && typeof json.transaction === 'object' ? json.transaction : json) as JsonRecord;
  }));
}

async function fetchTradeCandles({
  baseUrl,
  token,
  pair,
  openedAt,
  closedAt,
}: {
  baseUrl: string;
  token: string;
  pair: string;
  openedAt: string;
  closedAt: string;
}): Promise<JsonRecord[]> {
  const fromMs = Date.parse(openedAt);
  const toMs = Date.parse(closedAt);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) return [];
  const from = new Date(fromMs - 5 * 60_000).toISOString();
  const to = new Date(toMs + 5 * 60_000).toISOString();
  const json = await oandaGetJson(
    baseUrl,
    token,
    `/v3/instruments/${encodeURIComponent(pair)}/candles?price=M&granularity=M5&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
  );
  return Array.isArray(json.candles) ? json.candles as JsonRecord[] : [];
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
    learningAdjustmentsApplied: 0,
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
        let closingTransactions: JsonRecord[] = [];
        let excursion: JsonRecord | null = null;
        if (String(trade.state || '').toUpperCase() === 'CLOSED') {
          try {
            [closingTransactions, excursion] = await Promise.all([
              fetchClosingTransactions({
                baseUrl,
                token: credentials.token,
                accountId: brokerAccountId,
                transactionIds: trade.closingTransactionIDs,
              }),
              fetchTradeCandles({
                baseUrl,
                token: credentials.token,
                pair: String(trade.instrument || opening.pair || ''),
                openedAt: String(trade.openTime || opening.opened_at || ''),
                closedAt: String(trade.closeTime || opening.closed_at || ''),
              }).then((candles) => computeTradeExcursion({
                pair: trade.instrument || opening.pair,
                direction: opening.direction || (Number(trade.initialUnits) >= 0 ? 'long' : 'short'),
                entryPrice: trade.price ?? opening.entry_price,
                stopLoss: trade.stopLossOrder?.price ?? opening.stop_loss,
                candles,
              })),
            ]);
          } catch (contextError) {
            console.warn(`[ACTUAL_TRADE_RECONCILIATION] context fetch failed trade=${brokerTradeId}: ${messageOf(contextError)}`);
          }
        }
        const row = buildActualTradeLifecycleRow({ opening, trade, closingTransactions, excursion, reconciledAt: now }) as JsonRecord;
        row.opening_snapshot = sanitizePayload(row.opening_snapshot);
        row.broker_snapshot = sanitizePayload(row.broker_snapshot);
        lifecycleRows.push(row);
      } catch (error) {
        baseResult.failures.push({ brokerTradeId, error: messageOf(error) });
      }
    }

    if (lifecycleRows.length) {
      const candidateIds = lifecycleRows.map((row) => row.candidate_signal_id).filter(Boolean);
      const brokerTradeIds = lifecycleRows.map((row) => row.broker_trade_id).filter(Boolean);
      if (candidateIds.length || brokerTradeIds.length) {
        const queries = [];
        if (candidateIds.length) queries.push(supabase
          .from('signal_observations')
          .select('id,candidate_signal_id,broker_trade_id,observed_at')
          .eq('user_id', userId)
          .eq('broker_account_id', brokerAccountId)
          .in('candidate_signal_id', candidateIds));
        if (brokerTradeIds.length) queries.push(supabase
          .from('signal_observations')
          .select('id,candidate_signal_id,broker_trade_id,observed_at')
          .eq('user_id', userId)
          .eq('broker_account_id', brokerAccountId)
          .in('broker_trade_id', brokerTradeIds));
        const observationResults = await Promise.all(queries);
        const failedObservationQuery = observationResults.find((result) => result.error);
        if (failedObservationQuery?.error) throw failedObservationQuery.error;
        const observations = observationResults.flatMap((result) => result.data || []);
        for (const row of lifecycleRows) {
          const match = (observations || [])
            .filter((observation: JsonRecord) =>
              (row.candidate_signal_id && observation.candidate_signal_id === row.candidate_signal_id) ||
              (row.broker_trade_id && observation.broker_trade_id === row.broker_trade_id))
            .sort((a: JsonRecord, b: JsonRecord) => Date.parse(b.observed_at) - Date.parse(a.observed_at))[0];
          row.signal_observation_id = match?.id || null;
        }
      }
      const { data: persisted, error } = await supabase
        .from('actual_trade_lifecycles')
        .upsert(lifecycleRows, { onConflict: 'user_id,broker_account_id,broker_trade_id' })
        .select('id,user_id,broker_account_id,environment,engine,pair,direction,broker_trade_id,candidate_signal_id,closed_at,realized_r,mfe_r,mae_r,failure_reasons,entry_context,learning_adjustment');
      if (error) throw error;

      const closed = (persisted || []).filter((row: JsonRecord) => row.closed_at);
      if (closed.length) {
        const adjustmentRows = closed.map((row: JsonRecord) => ({
          user_id: row.user_id,
          broker_account_id: row.broker_account_id,
          environment: row.environment || 'unknown',
          engine: row.engine,
          pair: row.pair,
          direction: row.direction,
          observed_at: row.closed_at || now.toISOString(),
          mode: 'active',
          recommendation_stage: 'post_trade_outcome',
          sample_size: 1,
          original_confidence: null,
          market_study_adjustment: 0,
          engine_trade_adjustment: 0,
          combined_adjustment: 0,
          final_confidence: null,
          component_adjustments: [{
            type: 'actual_broker_outcome',
            realizedR: row.realized_r,
            mfeR: row.mfe_r,
            maeR: row.mae_r,
          }],
          reasons: row.failure_reasons || [],
          hard_gates_preserved: ['ict_corrective_gate', 'risk', 'spread', 'duplicate'],
          candidate_snapshot: {
            candidateSignalId: row.candidate_signal_id,
            brokerTradeId: row.broker_trade_id,
            entryContext: row.entry_context,
          },
          adjustment_type: 'post_trade_outcome',
          applied: true,
          applied_at: now.toISOString(),
          source_trade_lifecycle_id: row.id,
          failure_reasons: row.failure_reasons || [],
        }));
        const { data: audits, error: auditError } = await supabase
          .from('engine_learning_adjustment_audit')
          .upsert(adjustmentRows, { onConflict: 'source_trade_lifecycle_id,adjustment_type' })
          .select('id,source_trade_lifecycle_id');
        if (auditError) throw auditError;
        await Promise.all((audits || []).map((audit: JsonRecord) => supabase
          .from('actual_trade_lifecycles')
          .update({
            applied_learning_audit_id: audit.id,
            learning_applied: true,
            updated_at: now.toISOString(),
          })
          .eq('id', audit.source_trade_lifecycle_id)));
        baseResult.learningAdjustmentsApplied = (audits || []).length;
      }
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
