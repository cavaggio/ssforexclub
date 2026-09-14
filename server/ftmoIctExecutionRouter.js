import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const REQUIRED_RISK_POLICY_VERSION = '1.21';
const REQUIRED_BRIDGE_VERSION = '1.23';
const MT5_RESULT_POLL_MS = 250;

export const FTMO_ICT_EXECUTION_POLICY = Object.freeze({
  riskPercent: 1,
  stopPips: 10,
  breakEvenPips: 10,
  firstPartialPips: 15,
  firstPartialPercent: 80,
  finalTakeProfitPips: 18,
  finalPartialPercent: 20,
});

function clean(value) {
  return String(value ?? '').trim();
}

function truthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(clean(value).toLowerCase());
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

let supabaseClient = null;
function db(env = process.env) {
  if (supabaseClient) return supabaseClient;
  const url = clean(env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || env.VITE_SUPABASE_URL);
  const key = clean(env.SUPABASE_SERVICE_ROLE_KEY);
  if (!url || !key) throw new Error('Supabase service-role configuration is missing for FTMO execution routing');
  supabaseClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return supabaseClient;
}

function maskAccount(accountLogin) {
  const value = clean(accountLogin);
  if (!value) return '***';
  if (value.length <= 4) return `***${value}`;
  return `${'*'.repeat(Math.min(6, value.length - 4))}${value.slice(-4)}`;
}

export function buildFtmoIctOrderPayload({ pair, direction, signalId } = {}) {
  const symbol = clean(pair).toUpperCase();
  const normalizedDirection = clean(direction).toLowerCase();
  if (!symbol) throw new Error('FTMO ICT route requires a symbol');
  if (!['long', 'short'].includes(normalizedDirection)) {
    throw new Error('FTMO ICT route requires direction=long|short');
  }
  return {
    symbol,
    side: normalizedDirection === 'long' ? 'buy' : 'sell',
    riskPercent: FTMO_ICT_EXECUTION_POLICY.riskPercent,
    stopPips: FTMO_ICT_EXECUTION_POLICY.stopPips,
    breakEvenPips: FTMO_ICT_EXECUTION_POLICY.breakEvenPips,
    firstPartialPips: FTMO_ICT_EXECUTION_POLICY.firstPartialPips,
    firstPartialPercent: FTMO_ICT_EXECUTION_POLICY.firstPartialPercent,
    finalTakeProfitPips: FTMO_ICT_EXECUTION_POLICY.finalTakeProfitPips,
    finalPartialPercent: FTMO_ICT_EXECUTION_POLICY.finalPartialPercent,
    strategy: 'ICT',
    signalId: signalId ? String(signalId) : null,
    source: 'signal-stack-auto-ai',
    testMode: false,
  };
}

export function mt5ResultToOandaFill(result = {}, { fallbackPrice = null, fallbackUnits = null } = {}) {
  const order = Number(result?.order);
  const deal = Number(result?.deal);
  const positionTicket = Number(result?.positionTicket);
  const positionIdentifier = Number(result?.positionIdentifier);
  const fillPrice = Number(result?.price);
  const executionResolved = result?.executionResolved === true;

  if (
    !executionResolved ||
    !Number.isFinite(order) || order <= 0 ||
    !Number.isFinite(deal) || deal <= 0 ||
    !Number.isFinite(positionTicket) || positionTicket <= 0
  ) {
    throw new Error('MT5 EA reported success without resolved broker order/deal/position identifiers');
  }

  const tradeId = String(positionTicket);
  const price = Number.isFinite(fillPrice) && fillPrice > 0
    ? fillPrice
    : Number(fallbackPrice);
  const notionalUnits = Number(result?.notionalUnits);
  const reportedUnits = Number.isFinite(notionalUnits) && notionalUnits > 0
    ? notionalUnits
    : Number(fallbackUnits);

  return {
    orderFillTransaction: {
      id: String(deal),
      tradeID: tradeId,
      tradeOpened: { tradeID: tradeId },
      price: Number.isFinite(price) ? String(price) : undefined,
      units: Number.isFinite(reportedUnits) ? String(reportedUnits) : undefined,
    },
    executionProvider: 'ftmo_mt5_ea',
    mt5Execution: {
      order: String(order),
      deal: String(deal),
      positionTicket: tradeId,
      positionIdentifier: Number.isFinite(positionIdentifier) && positionIdentifier > 0
        ? String(positionIdentifier)
        : null,
      volume: Number.isFinite(Number(result?.volume)) ? Number(result.volume) : null,
      notionalUnits: Number.isFinite(notionalUnits) ? notionalUnits : null,
      price: Number.isFinite(price) ? price : null,
      riskPercent: Number.isFinite(Number(result?.riskPercent)) ? Number(result.riskPercent) : null,
      executionResolved: true,
    },
  };
}

async function resolveFtmoExecutionContext(userId, env = process.env) {
  const normalizedUserId = clean(userId);
  if (!normalizedUserId) return { active: false, ready: false, reason: 'No user-scoped execution context' };

  const database = db(env);
  const { data: settings, error: settingsError } = await database
    .from('user_trading_settings')
    .select('active_broker,active_broker_connection_id,active_environment,live_trading_acknowledged')
    .eq('user_id', normalizedUserId)
    .maybeSingle();
  if (settingsError) throw new Error(`FTMO settings lookup failed: ${settingsError.message}`);
  if (!settings || clean(settings.active_broker).toLowerCase() !== 'ftmo') {
    return { active: false, ready: false, reason: 'FTMO is not the active execution broker' };
  }

  const connectionId = clean(settings.active_broker_connection_id);
  if (!connectionId) {
    return { active: true, ready: false, reason: 'FTMO is selected but no active FTMO connection is selected' };
  }
  if (settings.live_trading_acknowledged !== true) {
    return { active: true, ready: false, reason: 'FTMO trading-risk acknowledgement is not accepted' };
  }

  const { data: connection, error: connectionError } = await database
    .from('broker_connections')
    .select('account_id,environment,is_active,validation_status')
    .eq('user_id', normalizedUserId)
    .eq('id', connectionId)
    .eq('broker', 'ftmo')
    .maybeSingle();
  if (connectionError) throw new Error(`FTMO connection lookup failed: ${connectionError.message}`);
  if (!connection || connection.is_active !== true) {
    return { active: true, ready: false, reason: 'Selected FTMO connection is missing or inactive' };
  }
  if (clean(connection.validation_status).toLowerCase() !== 'validated') {
    return { active: true, ready: false, reason: 'Selected FTMO connection has not been validated' };
  }

  const accountLogin = clean(connection.account_id);
  const { data: terminal, error: terminalError } = await database
    .from('mt5_ea_terminals')
    .select('terminal_id,status,last_heartbeat_at,order_test_verified_at,trading_locked,risk_policy_version,bridge_version')
    .eq('user_id', normalizedUserId)
    .eq('account_login', accountLogin)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (terminalError) throw new Error(`FTMO terminal lookup failed: ${terminalError.message}`);

  const heartbeatAt = terminal?.last_heartbeat_at
    ? new Date(String(terminal.last_heartbeat_at)).getTime()
    : NaN;
  const heartbeatFresh = Number.isFinite(heartbeatAt) && Date.now() - heartbeatAt <= 120_000;

  let reason = 'FTMO MT5 execution ready';
  if (!truthy(env.FTMO_ENABLED)) reason = 'FTMO_ENABLED is false';
  else if (!truthy(env.FTMO_LIVE_EXECUTION_ENABLED)) reason = 'FTMO_LIVE_EXECUTION_ENABLED is false';
  else if (!truthy(env.FTMO_AUTO_TRADE_ENABLED)) reason = 'FTMO_AUTO_TRADE_ENABLED is false';
  else if (!terminal || terminal.status !== 'connected') reason = 'MT5 EA terminal is not connected';
  else if (!heartbeatFresh) reason = 'MT5 EA heartbeat is stale';
  else if (clean(terminal.risk_policy_version) !== REQUIRED_RISK_POLICY_VERSION) {
    reason = `Risk policy ${REQUIRED_RISK_POLICY_VERSION} is required before FTMO execution`;
  } else if (clean(terminal.bridge_version) !== REQUIRED_BRIDGE_VERSION) {
    reason = `SignalStackBridge ${REQUIRED_BRIDGE_VERSION} is required before FTMO execution`;
  } else if (terminal.trading_locked === true) reason = 'MT5 EA daily risk lock is active';
  else if (!terminal.order_test_verified_at) reason = 'Minimum-volume MT5 order test has not been verified';

  return {
    active: true,
    ready: reason === 'FTMO MT5 execution ready',
    reason,
    userId: normalizedUserId,
    accountLogin,
    environment: clean(settings.active_environment || connection.environment),
    terminalId: clean(terminal?.terminal_id),
  };
}

async function existingCommandByKey(database, idempotencyKey) {
  const { data, error } = await database
    .from('mt5_ea_commands')
    .select('id')
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();
  if (error) throw new Error(`MT5 EA command lookup failed: ${error.message}`);
  return data?.id ? String(data.id) : null;
}

async function enqueueMt5Order(context, payload, idempotencyKey, env = process.env) {
  const database = db(env);
  const expiresAt = new Date(Date.now() + 120_000).toISOString();
  const { data, error } = await database
    .from('mt5_ea_commands')
    .insert({
      account_login: context.accountLogin,
      terminal_id: context.terminalId,
      command_type: 'order_place',
      payload,
      idempotency_key: idempotencyKey,
      status: 'pending',
      expires_at: expiresAt,
    })
    .select('id')
    .single();

  if (!error && data?.id) return String(data.id);
  if (error?.code === '23505') {
    const existingId = await existingCommandByKey(database, idempotencyKey);
    if (existingId) return existingId;
  }
  throw new Error(`MT5 EA queue insert failed: ${error?.message || 'no command id returned'}`);
}

async function waitForMt5Result(commandId, env = process.env) {
  const timeoutMs = positiveNumber(env.FTMO_MT5_EA_TIMEOUT_MS || env.FTMO_MT5_BRIDGE_TIMEOUT_MS, 15_000);
  const deadline = Date.now() + timeoutMs;
  const database = db(env);

  while (Date.now() < deadline) {
    const { data, error } = await database
      .from('mt5_ea_commands')
      .select('status,result,error')
      .eq('id', commandId)
      .maybeSingle();
    if (error) throw new Error(`MT5 EA queue read failed: ${error.message}`);
    if (!data) throw new Error('MT5 EA command disappeared from queue');
    if (data.status === 'completed') return data.result || {};
    if (data.status === 'failed' || data.status === 'expired') {
      throw new Error(data.error || `MT5 EA command ${data.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, MT5_RESULT_POLL_MS));
  }

  throw new Error(`MT5 EA response timed out after ${timeoutMs}ms; command remains idempotently reserved`);
}

function failClosedClient(oandaClient, reason) {
  return {
    ...oandaClient,
    executionProvider: 'ftmo_mt5_ea',
    post: async (path, body) => {
      if (/\/v3\/accounts\/[^/]+\/orders(?:\?|$)/i.test(String(path || ''))) {
        throw new Error(`FTMO MT5 execution blocked: ${reason}. No OANDA execution fallback is permitted.`);
      }
      return oandaClient.post(path, body);
    },
  };
}

/**
 * Preserve OANDA strictly as the ICT market-data/risk-analysis transport while
 * routing the final order to the user's selected FTMO MT5 EA account. If FTMO
 * is selected but unavailable, order submission fails closed and NEVER falls
 * through to OANDA.
 */
export async function routeIctExecutionClient(oandaClient, {
  pair,
  direction,
  signalId = null,
  fallbackPrice = null,
} = {}) {
  const userId = clean(oandaClient?.userId);
  if (!userId) return oandaClient;

  let context;
  try {
    context = await resolveFtmoExecutionContext(userId);
  } catch (error) {
    return failClosedClient(oandaClient, `FTMO route resolution failed: ${error.message}`);
  }

  if (!context.active) return oandaClient;
  if (!context.ready) return failClosedClient(oandaClient, context.reason);

  const payload = buildFtmoIctOrderPayload({ pair, direction, signalId });
  const idempotencyKey = `ftmo-ict:${userId}:${context.accountLogin}:${signalId || `${pair}:${direction}:${crypto.randomUUID()}`}`;

  console.log(
    `[ICT_MT5_ROUTE] user=${userId.slice(0, 4)}… executionBroker=ftmo ` +
    `account=${maskAccount(context.accountLogin)} terminal=${context.terminalId} pair=${pair} direction=${direction}`,
  );

  return {
    ...oandaClient,
    executionProvider: 'ftmo_mt5_ea',
    executionAccountId: context.accountLogin,
    post: async (path, body) => {
      if (!/\/v3\/accounts\/[^/]+\/orders(?:\?|$)/i.test(String(path || ''))) {
        return oandaClient.post(path, body);
      }

      const commandId = await enqueueMt5Order(context, payload, idempotencyKey);
      const result = await waitForMt5Result(commandId);
      const fallbackUnits = Number(body?.order?.units);
      const synthetic = mt5ResultToOandaFill(result, {
        fallbackPrice,
        fallbackUnits: Number.isFinite(fallbackUnits) ? Math.abs(fallbackUnits) : null,
      });
      console.log(
        `[ICT_MT5_ROUTE] filled account=${maskAccount(context.accountLogin)} pair=${pair} ` +
        `mt5Position=${synthetic.mt5Execution.positionTicket} price=${synthetic.mt5Execution.price ?? 'unknown'} ` +
        `command=${commandId}`,
      );
      return synthetic;
    },
  };
}
