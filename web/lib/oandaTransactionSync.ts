import 'server-only';

import { getServerSupabase } from './db';
import { logTradeEvent } from './tradeLogs';

type Env = 'practice' | 'live' | 'paper';

type SyncArgs = {
  userId: string;
  brokerAccountId: string;
  environment: Env;
  baseUrl: string;
  token: string;
  lookbackMinutes?: number;
};

type OandaTransaction = Record<string, any>;

type CloseEvent = {
  transactionId: string;
  tradeId: string | null;
  instrument: string | null;
  reason: string;
  time: string | null;
  price: number | null;
  unitsClosed: number | null;
  realizedPL: number | null;
  side: 'long' | 'short' | null;
  raw: OandaTransaction;
};

function numeric(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeBaseUrl(baseUrl: string): string {
  return String(baseUrl || '').replace(/\/$/, '');
}

function isNumericId(value: unknown): boolean {
  return /^\d+$/.test(String(value ?? ''));
}

function maxTransactionId(transactions: OandaTransaction[]): string | null {
  let best: bigint | null = null;

  for (const tx of transactions) {
    if (!isNumericId(tx?.id)) continue;
    const id = BigInt(String(tx.id));
    if (best === null || id > best) best = id;
  }

  return best === null ? null : String(best);
}

function deriveClosedSide(txUnits: unknown): 'long' | 'short' | null {
  const units = Number(txUnits);
  if (!Number.isFinite(units) || units === 0) return null;

  // OANDA close order units are opposite the original position.
  // Negative close units reduce/close a long. Positive close units reduce/close a short.
  return units < 0 ? 'long' : 'short';
}

function classifyCloseReason(reason: string): string {
  const r = String(reason || '').toUpperCase();

  if (r.includes('TAKE_PROFIT')) return 'TP_HIT';
  if (r.includes('STOP_LOSS')) return 'SL_HIT';
  if (r.includes('MARKET_ORDER_TRADE_CLOSE')) return 'BROKER_MANUAL_CLOSE';
  if (r.includes('CLIENT_ORDER')) return 'CLIENT_ORDER_CLOSE';

  return r || 'BROKER_CLOSE';
}

async function oandaGetJson(baseUrl: string, token: string, pathOrUrl: string): Promise<any> {
  const url = pathOrUrl.startsWith('http')
    ? pathOrUrl
    : `${normalizeBaseUrl(baseUrl)}${pathOrUrl}`;

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    cache: 'no-store',
  });

  const text = await res.text();
  let json: any = null;

  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    const detail = json?.errorMessage || json?.error || text || `HTTP ${res.status}`;
    throw new Error(`OANDA transaction fetch failed: ${detail}`);
  }

  return json;
}

async function getLastSyncedId(
  userId: string,
  brokerAccountId: string,
  environment: Env,
): Promise<string | null> {
  try {
    const supabase = getServerSupabase();

    const { data, error } = await supabase
      .from('oanda_transaction_sync_state')
      .select('last_transaction_id')
      .eq('user_id', userId)
      .eq('broker_account_id', brokerAccountId)
      .eq('environment', environment)
      .maybeSingle();

    if (error) {
      console.warn(`[OANDA_TX_SYNC] sync state read failed: ${error.message}`);
      return null;
    }

    return data?.last_transaction_id ? String(data.last_transaction_id) : null;
  } catch (err) {
    console.warn(`[OANDA_TX_SYNC] sync state read exception: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function saveLastSyncedId(
  userId: string,
  brokerAccountId: string,
  environment: Env,
  lastTransactionId: string,
): Promise<void> {
  try {
    const supabase = getServerSupabase();

    const { error } = await supabase
      .from('oanda_transaction_sync_state')
      .upsert(
        {
          user_id: userId,
          broker_account_id: brokerAccountId,
          environment,
          last_transaction_id: lastTransactionId,
          last_synced_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,broker_account_id,environment' },
      );

    if (error) {
      console.warn(`[OANDA_TX_SYNC] sync state save failed: ${error.message}`);
    }
  } catch (err) {
    console.warn(`[OANDA_TX_SYNC] sync state save exception: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function fetchTransactions(args: SyncArgs, sinceId: string | null): Promise<{
  transactions: OandaTransaction[];
  lastTransactionId: string | null;
}> {
  const accountId = encodeURIComponent(args.brokerAccountId);

  if (sinceId && isNumericId(sinceId)) {
    const json = await oandaGetJson(
      args.baseUrl,
      args.token,
      `/v3/accounts/${accountId}/transactions/sinceid?id=${encodeURIComponent(sinceId)}`,
    );

    return {
      transactions: Array.isArray(json.transactions) ? json.transactions : [],
      lastTransactionId: json.lastTransactionID ? String(json.lastTransactionID) : null,
    };
  }

  const lookbackMinutes =
    args.lookbackMinutes ??
    Number(process.env.OANDA_TRANSACTION_SYNC_LOOKBACK_MINUTES || 1440);

  const from = new Date(Date.now() - Math.max(5, lookbackMinutes) * 60_000).toISOString();

  const indexJson = await oandaGetJson(
    args.baseUrl,
    args.token,
    `/v3/accounts/${accountId}/transactions?from=${encodeURIComponent(from)}&pageSize=500`,
  );

  const pageUrls: string[] = Array.isArray(indexJson.pages) ? indexJson.pages : [];
  const maxPages = Number(process.env.OANDA_TRANSACTION_SYNC_MAX_PAGES || 10);
  const transactions: OandaTransaction[] = [];

  if (pageUrls.length) {
    for (const pageUrl of pageUrls.slice(-maxPages)) {
      const page = await oandaGetJson(args.baseUrl, args.token, pageUrl);
      if (Array.isArray(page.transactions)) transactions.push(...page.transactions);
    }
  } else if (Array.isArray(indexJson.transactions)) {
    transactions.push(...indexJson.transactions);
  }

  return {
    transactions,
    lastTransactionId: indexJson.lastTransactionID ? String(indexJson.lastTransactionID) : null,
  };
}

function closeEventsFromTransaction(tx: OandaTransaction): CloseEvent[] {
  if (!tx || tx.type !== 'ORDER_FILL') return [];

  const events: CloseEvent[] = [];
  const transactionId = String(tx.id || '');
  const instrument = typeof tx.instrument === 'string' ? tx.instrument : null;
  const reason = String(tx.reason || '');
  const time = typeof tx.time === 'string' ? tx.time : null;
  const price = numeric(tx.price);
  const side = deriveClosedSide(tx.units);

  const tradesClosed = Array.isArray(tx.tradesClosed) ? tx.tradesClosed : [];

  for (const closed of tradesClosed) {
    events.push({
      transactionId,
      tradeId: closed?.tradeID ? String(closed.tradeID) : null,
      instrument,
      reason,
      time,
      price,
      unitsClosed: numeric(closed?.units) == null ? null : Math.abs(Number(closed.units)),
      realizedPL: numeric(closed?.realizedPL ?? closed?.pl ?? tx.pl),
      side,
      raw: tx,
    });
  }

  if (tx.tradeReduced) {
    const reduced = tx.tradeReduced;

    events.push({
      transactionId,
      tradeId: reduced?.tradeID ? String(reduced.tradeID) : null,
      instrument,
      reason,
      time,
      price,
      unitsClosed: numeric(reduced?.units) == null ? null : Math.abs(Number(reduced.units)),
      realizedPL: numeric(reduced?.realizedPL ?? reduced?.pl ?? tx.pl),
      side,
      raw: tx,
    });
  }

  // Ignore opening fills. They are logged by the trade execution path.
  return events.filter((event) => event.tradeId || event.realizedPL !== null);
}

export async function syncOandaTransactionsForUser(args: SyncArgs): Promise<{
  ok: boolean;
  accountId: string;
  environment: Env;
  fetched: number;
  closeEvents: number;
  logged: number;
  failed: number;
  lastTransactionId: string | null;
  error?: string;
}> {
  const maskedAccount =
    args.brokerAccountId.length > 6
      ? `${args.brokerAccountId.slice(0, 3)}…${args.brokerAccountId.slice(-3)}`
      : '***';

  const tag = `[OANDA_TX_SYNC] user=${args.userId.slice(0, 6)} account=${maskedAccount} env=${args.environment}`;

  try {
    const sinceId = await getLastSyncedId(args.userId, args.brokerAccountId, args.environment);
    const { transactions, lastTransactionId } = await fetchTransactions(args, sinceId);

    let logged = 0;
    let failed = 0;
    let closeEvents = 0;

    for (const tx of transactions) {
      const events = closeEventsFromTransaction(tx);
      closeEvents += events.length;

      for (const event of events) {
        const closeReason = classifyCloseReason(event.reason);
        const pnl = event.realizedPL;

        const result = await logTradeEvent({
          userId: args.userId,
          broker: 'oanda',
          brokerAccountId: args.brokerAccountId,
          environment: args.environment,
          eventType: 'closed',
          instrument: event.instrument,
          tradeId: event.tradeId,
          brokerOrderId: event.transactionId,
          side: event.side,
          unitsClosed: event.unitsClosed,
          exitPrice: event.price,
          realizedPL: pnl,
          recommendation: closeReason,
          reason: `OANDA ${closeReason} transaction ${event.transactionId}`,
          rawPayload: {
            source: 'oanda_transaction_sync',
            transactionId: event.transactionId,
            reason: event.reason,
            transaction: event.raw,
          },
          edge: {
            pair: event.instrument,
            direction: event.side,
            exitTime: event.time ?? new Date().toISOString(),
            pnl,
            winLoss: pnl == null ? null : pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'breakeven',
          },
        });

        if (result.ok) logged += 1;
        else failed += 1;

        if (result.ok && closeReason === 'SL_HIT' && event.tradeId) {
          const supabase = getServerSupabase();
          const lockedUntil = new Date(Date.now() + Number(process.env.POST_LOSS_REENTRY_LOCK_HOURS || 24) * 3600000).toISOString();
          await supabase.from('execution_reservations').update({ status: 'loss_locked', locked_until: lockedUntil, updated_at: new Date().toISOString() }).eq('trade_id', String(event.tradeId));
        }
      }
    }

    const nextLast = lastTransactionId || maxTransactionId(transactions) || sinceId;

    if (nextLast) {
      await saveLastSyncedId(args.userId, args.brokerAccountId, args.environment, nextLast);
    }

    console.log(
      `${tag} fetched=${transactions.length} closeEvents=${closeEvents} logged=${logged} failed=${failed} last=${nextLast ?? 'none'}`,
    );

    return {
      ok: true,
      accountId: args.brokerAccountId,
      environment: args.environment,
      fetched: transactions.length,
      closeEvents,
      logged,
      failed,
      lastTransactionId: nextLast ?? null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`${tag} failed: ${message}`);

    return {
      ok: false,
      accountId: args.brokerAccountId,
      environment: args.environment,
      fetched: 0,
      closeEvents: 0,
      logged: 0,
      failed: 0,
      lastTransactionId: null,
      error: message,
    };
  }
}
