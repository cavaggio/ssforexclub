import 'server-only';

import crypto from 'crypto';
import { getServerSupabase } from './db';

export const FTMO_EXECUTION_POLICY = Object.freeze({
  baseRiskPercent: 1,
  postStopLossRiskPercent: 0.5,
  dailyLossLockPercent: 2,
  stopLossPips: 15,
  breakEvenPips: 10,
  firstPartialPips: 15,
  firstPartialPercent: 80,
  finalTakeProfitPips: 18,
  finalPartialPercent: 20,
  blendedRewardRisk: 1.04,
  finalTargetRewardRisk: 1.2,
});

export type FtmoAutoOrder = {
  symbol: string;
  side: 'buy' | 'sell';
  /** Optional lower risk request. The EA hard-caps normal trades at 1%, and at
   * 0.5% for the remainder of the NY day after a Signal Stack stop-loss. */
  riskPercent?: number;
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
  policy: typeof FTMO_EXECUTION_POLICY;
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
    policy: FTMO_EXECUTION_POLICY,
  };
}

async function enqueueCommand(args: {
  userId: string;
  accountLogin: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}) {
  const terminal = await latestTerminal(args.userId, args.accountLogin);
  if (!terminal?.terminal_id) {
    return { ok: false as const, blocked: true as const, reason: 'FTMO terminal disappeared before queue submission' };
  }

  const supabase = getServerSupabase();
  const { data, error } = await supabase
    .from('mt5_ea_commands')
    .insert({
      account_login: args.accountLogin,
      terminal_id: terminal.terminal_id,
      command_type: 'order_place',
      payload: args.payload,
      idempotency_key: args.idempotencyKey,
      status: 'pending',
      expires_at: new Date(Date.now() + 120_000).toISOString(),
    })
    .select('id,status,created_at')
    .single();

  if (error) {
    if (error.code === '23505') {
      return { ok: false as const, blocked: true as const, reason: 'Duplicate FTMO execution reservation' };
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
  };
}

/**
 * Production autonomous order queue. Server callers are not allowed to choose
 * SL/TP geometry or exceed 1% risk. The MT5 EA independently re-applies the
 * same hard policy and reduces risk to 0.5% after an SL for the rest of the NY
 * trading day.
 */
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
  if (!symbol || !['buy', 'sell'].includes(side)) {
    return { ok: false as const, blocked: true as const, reason: 'Invalid FTMO order payload', readiness };
  }

  const requestedRisk = finitePositive(args.order.riskPercent) ?? FTMO_EXECUTION_POLICY.baseRiskPercent;
  const riskPercent = Math.min(requestedRisk, FTMO_EXECUTION_POLICY.baseRiskPercent);
  const idempotencyKey = String(args.idempotencyKey || '').trim() ||
    `ftmo-auto:${args.userId}:${args.accountLogin}:${args.order.signalId || crypto.randomUUID()}`;

  const queued = await enqueueCommand({
    userId: args.userId,
    accountLogin: args.accountLogin,
    idempotencyKey,
    payload: {
      symbol,
      side,
      riskPercent,
      stopPips: FTMO_EXECUTION_POLICY.stopLossPips,
      breakEvenPips: FTMO_EXECUTION_POLICY.breakEvenPips,
      firstPartialPips: FTMO_EXECUTION_POLICY.firstPartialPips,
      firstPartialPercent: FTMO_EXECUTION_POLICY.firstPartialPercent,
      finalTakeProfitPips: FTMO_EXECUTION_POLICY.finalTakeProfitPips,
      finalPartialPercent: FTMO_EXECUTION_POLICY.finalPartialPercent,
      strategy: args.order.strategy || null,
      signalId: args.order.signalId || null,
      source: 'signal-stack-auto-ai',
      testMode: false,
    },
  });
  return { ...queued, readiness, policy: FTMO_EXECUTION_POLICY };
}

/**
 * Controlled minimum-volume order test. This deliberately bypasses the
 * FTMO_ORDER_TEST_VERIFIED and auto-trade flags because its purpose is to earn
 * that verification. It still requires a fresh connected EA and the explicit
 * FTMO_LIVE_EXECUTION_ENABLED kill switch. The EA applies the same 15/10/15/18
 * protection geometry to the test position.
 */
export async function enqueueFtmoOrderTest(args: {
  userId: string;
  accountLogin: string;
  symbol: string;
  side: 'buy' | 'sell';
  volume: number;
  confirmationId: string;
}) {
  const config = flags();
  const terminal = await latestTerminal(args.userId, args.accountLogin);
  const heartbeatMs = terminal?.last_heartbeat_at ? new Date(String(terminal.last_heartbeat_at)).getTime() : NaN;
  const heartbeatFresh = Number.isFinite(heartbeatMs) && Date.now() - heartbeatMs <= 120_000;
  if (terminal?.status !== 'connected' || !heartbeatFresh) {
    return { ok: false as const, blocked: true as const, reason: 'MT5 EA terminal must be connected with a fresh heartbeat' };
  }
  if (!config.liveExecutionEnabled) {
    return { ok: false as const, blocked: true as const, reason: 'FTMO_LIVE_EXECUTION_ENABLED must be true for the explicit order test' };
  }

  const symbol = String(args.symbol || '').trim().toUpperCase();
  const side = String(args.side || '').trim().toLowerCase();
  const volume = finitePositive(args.volume);
  const confirmationId = String(args.confirmationId || '').trim();
  if (!symbol || !['buy', 'sell'].includes(side) || !volume || !confirmationId) {
    return { ok: false as const, blocked: true as const, reason: 'Invalid FTMO test order request' };
  }

  return enqueueCommand({
    userId: args.userId,
    accountLogin: args.accountLogin,
    idempotencyKey: `ftmo-order-test:${args.userId}:${args.accountLogin}:${confirmationId}`,
    payload: {
      symbol,
      side,
      volume,
      testMode: true,
      stopPips: FTMO_EXECUTION_POLICY.stopLossPips,
      breakEvenPips: FTMO_EXECUTION_POLICY.breakEvenPips,
      firstPartialPips: FTMO_EXECUTION_POLICY.firstPartialPips,
      firstPartialPercent: FTMO_EXECUTION_POLICY.firstPartialPercent,
      finalTakeProfitPips: FTMO_EXECUTION_POLICY.finalTakeProfitPips,
      finalPartialPercent: FTMO_EXECUTION_POLICY.finalPartialPercent,
      source: 'signal-stack-ftmo-order-test',
    },
  });
}
