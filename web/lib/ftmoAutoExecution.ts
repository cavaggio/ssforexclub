import 'server-only';

import crypto from 'crypto';
import { getServerSupabase } from './db';

export type FtmoAutoOrder = {
  symbol: string;
  side: 'buy' | 'sell';
  volume: number;
  stopLoss: number;
  takeProfit: number;
  strategy?: 'ICT' | 'V3' | 'PPR' | string;
  signalId?: string | null;
};

export type FtmoExecutionReadiness = {
  ready: boolean;
  autoTradeEnabled: boolean;
  liveExecutionEnabled: boolean;
  orderTestVerified: boolean;
  terminalConnected: boolean;
  heartbeatFresh: boolean;
  reason: string;
};

const truthy = (value: unknown) => ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());

function flags() {
  return {
    autoTradeEnabled: truthy(process.env.FTMO_AUTO_TRADE_ENABLED),
    liveExecutionEnabled: truthy(process.env.FTMO_LIVE_EXECUTION_ENABLED),
    orderTestVerified: truthy(process.env.FTMO_ORDER_TEST_VERIFIED),
  };
}

function finitePositive(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

async function latestTerminal(userId: string, accountLogin: string) {
  const supabase = getServerSupabase();
  const { data, error } = await supabase
    .from('mt5_ea_terminals')
    .select('account_login,server,terminal_id,status,last_heartbeat_at,last_error')
    .eq('user_id', userId)
    .eq('account_login', accountLogin)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`FTMO terminal lookup failed: ${error.message}`);
  return data;
}

export async function getFtmoExecutionReadiness(args: {
  userId: string;
  accountLogin: string;
}): Promise<FtmoExecutionReadiness> {
  const config = flags();
  const terminal = await latestTerminal(args.userId, args.accountLogin);
  const heartbeatMs = terminal?.last_heartbeat_at ? new Date(String(terminal.last_heartbeat_at)).getTime() : NaN;
  const heartbeatFresh = Number.isFinite(heartbeatMs) && Date.now() - heartbeatMs <= 120_000;
  const terminalConnected = terminal?.status === 'connected';

  let reason = 'FTMO execution ready';
  if (!terminalConnected) reason = 'MT5 EA terminal is not connected';
  else if (!heartbeatFresh) reason = 'MT5 EA heartbeat is stale';
  else if (!config.orderTestVerified) reason = 'Minimum-volume MT5 order test has not been verified';
  else if (!config.liveExecutionEnabled) reason = 'FTMO_LIVE_EXECUTION_ENABLED is false';
  else if (!config.autoTradeEnabled) reason = 'FTMO_AUTO_TRADE_ENABLED is false';

  return {
    ready: terminalConnected && heartbeatFresh && config.orderTestVerified && config.liveExecutionEnabled && config.autoTradeEnabled,
    ...config,
    terminalConnected,
    heartbeatFresh,
    reason,
  };
}

export async function enqueueFtmoAutoOrder(args: {
  userId: string;
  accountLogin: string;
  order: FtmoAutoOrder;
  idempotencyKey?: string;
}) {
  const readiness = await getFtmoExecutionReadiness({ userId: args.userId, accountLogin: args.accountLogin });
  if (!readiness.ready) {
    return { ok: false as const, blocked: true as const, reason: readiness.reason, readiness };
  }

  const symbol = String(args.order.symbol || '').trim().toUpperCase();
  const side = String(args.order.side || '').trim().toLowerCase();
  const volume = finitePositive(args.order.volume);
  const stopLoss = finitePositive(args.order.stopLoss);
  const takeProfit = finitePositive(args.order.takeProfit);
  if (!symbol || !['buy', 'sell'].includes(side) || !volume || !stopLoss || !takeProfit) {
    return { ok: false as const, blocked: true as const, reason: 'Invalid FTMO order payload', readiness };
  }

  const terminal = await latestTerminal(args.userId, args.accountLogin);
  if (!terminal?.terminal_id) {
    return { ok: false as const, blocked: true as const, reason: 'FTMO terminal disappeared before queue submission', readiness };
  }

  const idempotencyKey = String(args.idempotencyKey || '').trim() ||
    `ftmo-auto:${args.userId}:${args.accountLogin}:${args.order.signalId || crypto.randomUUID()}`;
  const supabase = getServerSupabase();
  const { data, error } = await supabase
    .from('mt5_ea_commands')
    .insert({
      account_login: args.accountLogin,
      terminal_id: terminal.terminal_id,
      command_type: 'order_place',
      payload: {
        symbol,
        side,
        volume,
        stopLoss,
        takeProfit,
        strategy: args.order.strategy || null,
        signalId: args.order.signalId || null,
        source: 'signal-stack-auto-ai',
      },
      idempotency_key: idempotencyKey,
      status: 'pending',
      expires_at: new Date(Date.now() + 120_000).toISOString(),
    })
    .select('id,status,created_at')
    .single();

  if (error) {
    if (error.code === '23505') {
      return { ok: false as const, blocked: true as const, reason: 'Duplicate FTMO execution reservation', readiness };
    }
    throw new Error(`FTMO command queue failed: ${error.message}`);
  }

  return {
    ok: true as const,
    queued: true as const,
    commandId: String(data.id),
    status: String(data.status),
    createdAt: String(data.created_at),
    terminalId: String(terminal.terminal_id),
    readiness,
  };
}
