from pathlib import Path
import sys

def write_file(path: str, content: str):
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    if p.exists():
        current = p.read_text(errors="ignore")
        if current == content:
            print(f"⚠️ Already current: {path}")
            return
        backup = p.with_suffix(p.suffix + ".bak_oanda_tx_sync")
        backup.write_text(current)
        print(f"🗂️ Backup saved: {backup}")
    p.write_text(content)
    print(f"✅ Wrote {path}")

def die(msg):
    print(f"❌ {msg}", file=sys.stderr)
    sys.exit(1)

# ============================================================
# 1) Supabase migration
# ============================================================

write_file(
    "supabase/migrations/20260709195000_oanda_transaction_sync_state.sql",
    """create extension if not exists pgcrypto;

create table if not exists public.oanda_transaction_sync_state (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  broker_account_id text not null,
  environment text not null check (environment in ('practice', 'live', 'paper')),
  last_transaction_id text,
  last_synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, broker_account_id, environment)
);

alter table public.oanda_transaction_sync_state enable row level security;

create index if not exists idx_oanda_transaction_sync_state_user
  on public.oanda_transaction_sync_state(user_id);

create index if not exists idx_oanda_transaction_sync_state_account
  on public.oanda_transaction_sync_state(broker_account_id, environment);
""",
)

# ============================================================
# 2) OANDA transaction sync library
# ============================================================

write_file(
    "web/lib/oandaTransactionSync.ts",
    r"""import 'server-only';

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
""",
)

# ============================================================
# 3) Manual authenticated sync route
# ============================================================

write_file(
    "web/app/api/scanner/transactions/sync/route.ts",
    r"""import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { resolveActiveBrokerForUser } from '@/lib/brokerResolver';
import { syncOandaTransactionsForUser } from '@/lib/oandaTransactionSync';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST() {
  const { userId } = await auth();

  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthenticated' }, { status: 401 });
  }

  const resolved = await resolveActiveBrokerForUser(userId);

  if (resolved.activeBroker !== 'oanda') {
    return NextResponse.json(
      { ok: false, error: 'OANDA transaction sync only supports OANDA accounts.' },
      { status: 409 },
    );
  }

  if (
    resolved.brokerCredentialStatus !== 'ready' ||
    !resolved.getCredentials ||
    !resolved.baseUrl
  ) {
    return NextResponse.json(
      {
        ok: false,
        error: resolved.reason,
        brokerCredentialStatus: resolved.brokerCredentialStatus,
        activeEnvironment: resolved.activeEnvironment,
      },
      { status: 409 },
    );
  }

  const creds = await resolved.getCredentials();

  if (!creds) {
    return NextResponse.json({ ok: false, error: 'Could not decrypt OANDA credentials' }, { status: 500 });
  }

  const sync = await syncOandaTransactionsForUser({
    userId,
    brokerAccountId: creds.accountId,
    environment: resolved.activeEnvironment as 'practice' | 'live' | 'paper',
    baseUrl: resolved.baseUrl,
    token: creds.token,
  });

  return NextResponse.json({ ok: sync.ok, sync }, { status: sync.ok ? 200 : 500 });
}
""",
)

# ============================================================
# 4) System cron sync route
# ============================================================

write_file(
    "web/app/api/cron/oanda-transaction-sync/route.ts",
    r"""import { NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/db';
import { resolveActiveBrokerForUser } from '@/lib/brokerResolver';
import { syncOandaTransactionsForUser } from '@/lib/oandaTransactionSync';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const mask = (id: string) => (id && id.length > 6 ? `${id.slice(0, 4)}…${id.slice(-2)}` : '***');

export async function POST(req: Request) {
  const secret = process.env.AUTO_AI_CRON_SECRET;

  if (!secret || req.headers.get('x-cron-secret') !== secret) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = getServerSupabase();

  const { data, error } = await supabase
    .from('user_trading_settings')
    .select('user_id');

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const rows = (data ?? []) as Array<{ user_id: string }>;
  const results: Record<string, unknown>[] = [];

  let syncedUsers = 0;
  let closeEvents = 0;
  let logged = 0;
  let failed = 0;

  for (const row of rows) {
    const userId = row.user_id;

    try {
      const resolved = await resolveActiveBrokerForUser(userId);

      if (resolved.activeBroker !== 'oanda') {
        results.push({ user: mask(userId), skipped: 'not_oanda' });
        continue;
      }

      if (
        resolved.brokerCredentialStatus !== 'ready' ||
        !resolved.getCredentials ||
        !resolved.baseUrl
      ) {
        results.push({
          user: mask(userId),
          skipped: resolved.brokerCredentialStatus,
          reason: resolved.reason,
        });
        continue;
      }

      const creds = await resolved.getCredentials();

      if (!creds) {
        results.push({ user: mask(userId), skipped: 'decrypt_failed' });
        continue;
      }

      const sync = await syncOandaTransactionsForUser({
        userId,
        brokerAccountId: creds.accountId,
        environment: resolved.activeEnvironment as 'practice' | 'live' | 'paper',
        baseUrl: resolved.baseUrl,
        token: creds.token,
      });

      syncedUsers += 1;
      closeEvents += sync.closeEvents;
      logged += sync.logged;
      failed += sync.failed;

      results.push({ user: mask(userId), sync });
    } catch (err) {
      failed += 1;
      results.push({
        user: mask(userId),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return NextResponse.json({
    ok: true,
    users: rows.length,
    syncedUsers,
    closeEvents,
    logged,
    failed,
    results,
  });
}
""",
)

# ============================================================
# 5) Patch tradeLogs.ts fallback
# ============================================================

trade_logs_path = Path("web/lib/tradeLogs.ts")
if not trade_logs_path.exists():
    die("web/lib/tradeLogs.ts not found")

trade_logs = trade_logs_path.read_text(errors="ignore")
trade_logs_original = trade_logs

old_block = """    if (error || !data) {
      console.warn(
        `[TRADE_LOG] insert failed user=${input.userId} event=${input.eventType}: ${error?.message ?? 'no row'}`,
      );
      return { ok: false, error: error?.message ?? 'no row returned' };
    }
    return { ok: true, id: String(data.id) };
"""

new_block = """    if (error || !data) {
      console.warn(
        `[TRADE_LOG] insert failed user=${input.userId} event=${input.eventType}: ${error?.message ?? 'no row'} — trying production-safe fallback`,
      );

      const fallbackRow = {
        user_id: input.userId,
        event_type: input.eventType,
        status: input.eventType === 'error' ? 'error' : 'ok',
        pair: normalizeInstrument(input.instrument ?? input.edge?.pair ?? null),
        direction: input.side ?? input.edge?.direction ?? null,
        entry_price: numeric(input.entryPrice),
        exit_price: numeric(input.exitPrice),
        realized_pl: numeric(input.realizedPL ?? input.edge?.pnl),
        unrealized_pl: numeric(input.unrealizedPL),
        payload: sanitizePayload({
          broker: input.broker,
          broker_account_id: input.brokerAccountId ?? null,
          environment: input.environment,
          trade_id: input.tradeId ?? null,
          broker_order_id: input.brokerOrderId ?? null,
          units: numeric(input.units),
          units_closed: numeric(input.unitsClosed),
          tp: numeric(input.tp),
          sl: numeric(input.sl),
          recommendation: input.recommendation ?? null,
          confidence: numeric(input.confidence),
          reason: input.reason ?? null,
          edge: input.edge ?? null,
        }) as Record<string, unknown>,
        raw_payload: input.rawPayload == null ? null : (sanitizePayload(input.rawPayload) as Record<string, unknown>),
      };

      const fallback = await supabase
        .from('trade_logs')
        .insert(fallbackRow)
        .select('id')
        .single();

      if (fallback.error || !fallback.data) {
        console.warn(
          `[TRADE_LOG] fallback insert failed user=${input.userId} event=${input.eventType}: ${fallback.error?.message ?? 'no row'}`,
        );
        return { ok: false, error: fallback.error?.message ?? error?.message ?? 'no row returned' };
      }

      return { ok: true, id: String(fallback.data.id) };
    }
    return { ok: true, id: String(data.id) };
"""

if "production-safe fallback" not in trade_logs:
    if old_block not in trade_logs:
        die("Could not find tradeLogs.ts insert failure block to patch.")
    trade_logs = trade_logs.replace(old_block, new_block, 1)

if trade_logs != trade_logs_original:
    backup = trade_logs_path.with_suffix(".ts.bak_oanda_tx_sync_fallback")
    backup.write_text(trade_logs_original)
    trade_logs_path.write_text(trade_logs)
    print(f"✅ Patched {trade_logs_path}")
    print(f"🗂️ Backup saved: {backup}")
else:
    print("⚠️ tradeLogs.ts fallback already present")

# ============================================================
# 6) Patch Railway scheduler
# ============================================================

scheduler_path = Path("server/ictAutoScheduler.js")
if not scheduler_path.exists():
    die("server/ictAutoScheduler.js not found")

scheduler = scheduler_path.read_text(errors="ignore")
scheduler_original = scheduler

hot_const = """export const AUTO_AI_HOT_TRIGGER_WATCH_INTERVAL_MS = parseInterval(
  'AUTO_AI_HOT_TRIGGER_WATCH_INTERVAL_MS',
  30 * 1000,
);
"""

if "OANDA_TRANSACTION_SYNC_INTERVAL_MS" not in scheduler:
    if hot_const not in scheduler:
        die("Could not find AUTO_AI_HOT_TRIGGER_WATCH_INTERVAL_MS block.")
    scheduler = scheduler.replace(
        hot_const,
        hot_const
        + """
export const OANDA_TRANSACTION_SYNC_INTERVAL_MS = parseInterval(
  'OANDA_TRANSACTION_SYNC_INTERVAL_MS',
  30 * 60 * 1000,
);
""",
        1,
    )

hot_timer = """  addTimer(setInterval(() => {
    void tick(nextUrl, secret, {
      scanMode: 'hot_watch',
      pairs: Array.from(hotPairs),
      logTag: '[AUTO_AI][HOT_WATCH]',
    });
  }, hotWatchMs));

  return {
"""

hot_timer_new = """  addTimer(setInterval(() => {
    void tick(nextUrl, secret, {
      scanMode: 'hot_watch',
      pairs: Array.from(hotPairs),
      logTag: '[AUTO_AI][HOT_WATCH]',
    });
  }, hotWatchMs));

  // Sync broker-side OANDA TP/SL closes into trade_logs for Edge Intelligence.
  // This is intentionally NOT gated by the Auto AI entry window.
  addTimer(setInterval(() => {
    void transactionSyncTick(nextUrl, secret);
  }, OANDA_TRANSACTION_SYNC_INTERVAL_MS));
  void transactionSyncTick(nextUrl, secret);

  return {
"""

if "transactionSyncTick(nextUrl, secret)" not in scheduler:
    if hot_timer not in scheduler:
        die("Could not find hot-watch timer block.")
    scheduler = scheduler.replace(hot_timer, hot_timer_new, 1)

update_fn = """function updateWatchStateFromCronResponse(text, tag) {
"""

sync_fn = r"""async function transactionSyncTick(nextUrl, secret) {
  const syncUrl = `${String(nextUrl).replace(/\/$/, '')}/api/cron/oanda-transaction-sync`;
  const tag = '[OANDA_TX_SYNC][SCHEDULER]';

  try {
    const res = await fetch(syncUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Cron-Secret': secret,
      },
      body: JSON.stringify({ source: 'railway-scheduler' }),
    });

    const text = await res.text();

    if (!res.ok) {
      console.log(`${tag} failed ${res.status}: ${text.slice(0, 300)}`);
      return { ok: false, status: res.status, body: text };
    }

    console.log(`${tag} complete ${text.slice(0, 300)}`);
    return { ok: true, status: res.status, body: text };
  } catch (err) {
    console.log(`${tag} unreachable: ${err?.message || err}`);
    return { ok: false, error: err?.message || String(err) };
  }
}

function updateWatchStateFromCronResponse(text, tag) {
"""

if "async function transactionSyncTick" not in scheduler:
    if update_fn not in scheduler:
        die("Could not find updateWatchStateFromCronResponse function.")
    scheduler = scheduler.replace(update_fn, sync_fn, 1)

if scheduler != scheduler_original:
    backup = scheduler_path.with_suffix(".js.bak_oanda_tx_sync_scheduler")
    backup.write_text(scheduler_original)
    scheduler_path.write_text(scheduler)
    print(f"✅ Patched {scheduler_path}")
    print(f"🗂️ Backup saved: {backup}")
else:
    print("⚠️ scheduler transaction sync already present")

print("\n✅ Missing OANDA transaction sync patch complete.")
