import { NextResponse } from 'next/server';
import { callScannerForCurrentUser, type AfterCallContext } from '@/lib/scannerProxy';
import { logTradeEvent } from '@/lib/tradeLogs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Engine = 'ict' | 'ppr' | 'v3';

type Body = {
  engine?: unknown;
  signal?: unknown;
};

function finite(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizePair(value: unknown): string | null {
  const pair = String(value || '').trim().toUpperCase();
  return /^[A-Z]{3}_[A-Z]{3}$/.test(pair) ? pair : null;
}

function normalizeDirection(signal: Record<string, any>): 'long' | 'short' | null {
  if (signal.direction === 'long' || signal.direction === 'short') return signal.direction;
  if (signal.signal === 'buy') return 'long';
  if (signal.signal === 'sell') return 'short';
  return null;
}

function executionFromResult(engine: Engine, data: unknown): Record<string, any> {
  const payload = data && typeof data === 'object' ? data as Record<string, any> : {};
  if (engine === 'ppr' && Array.isArray(payload.executed) && payload.executed.length > 0) {
    return payload.executed[0] as Record<string, any>;
  }
  return payload;
}

function reasonFromResult(engine: Engine, data: unknown, fallback?: string): string | null {
  const payload = data && typeof data === 'object' ? data as Record<string, any> : {};
  if (engine === 'ppr' && Array.isArray(payload.skipped) && payload.skipped.length > 0) {
    return typeof payload.skipped[0]?.reason === 'string' ? payload.skipped[0].reason : fallback ?? null;
  }
  return typeof payload.reason === 'string'
    ? payload.reason
    : typeof payload.error === 'string'
      ? payload.error
      : fallback ?? null;
}

function auditExecution({
  engine,
  signal,
  pair,
}: {
  engine: Engine;
  signal: Record<string, any>;
  pair: string;
}) {
  return async (
    ctx: AfterCallContext,
    result: { ok: boolean; data: unknown; error?: string },
  ) => {
    const trade = executionFromResult(engine, result.data);
    const opened = result.ok && (
      trade.success === true ||
      (engine === 'ppr' && typeof trade.tradeId === 'string')
    );
    const direction = normalizeDirection(signal);
    const tradeId = typeof trade.tradeId === 'string' ? trade.tradeId : null;

    await logTradeEvent({
      userId: ctx.userId,
      broker: ctx.broker,
      brokerAccountId: ctx.brokerAccountId,
      environment: ctx.environment,
      eventType: opened ? 'opened' : 'error',
      instrument: pair,
      tradeId,
      brokerOrderId: tradeId,
      side: direction,
      units: finite(trade.units) == null ? null : Math.abs(finite(trade.units) as number),
      entryPrice: finite(trade.fillPrice ?? trade.entryPrice),
      sl: finite(trade.stopLoss ?? trade.sizing?.stopLoss ?? signal.stopLoss),
      tp: finite(
        trade.takeProfit ??
        trade.targetProfit ??
        trade.sizing?.takeProfit ??
        signal.target1 ??
        signal.targetProfit ??
        signal.takeProfit,
      ),
      confidence: finite(signal.confidence),
      recommendation: `${engine.toUpperCase()} qualified signal button`,
      reason: reasonFromResult(engine, result.data, result.error),
      rawPayload: {
        executionSource: `qualified_signal_button_${engine}`,
        engine,
        signal,
        result: result.data,
      },
    });
  };
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: 'Body must be JSON' }, { status: 400 });
  }

  const engine = String(body.engine || '').toLowerCase() as Engine;
  if (!['ict', 'ppr', 'v3'].includes(engine)) {
    return NextResponse.json({ ok: false, error: 'engine must be ict, ppr, or v3' }, { status: 400 });
  }
  if (!body.signal || typeof body.signal !== 'object') {
    return NextResponse.json({ ok: false, error: 'Missing qualified signal' }, { status: 400 });
  }

  const signal = body.signal as Record<string, any>;
  const pair = normalizePair(signal.pair);
  if (!pair) {
    return NextResponse.json({ ok: false, error: 'Invalid signal pair' }, { status: 400 });
  }

  if (engine === 'v3') {
    return callScannerForCurrentUser({
      internalPath: '/api/internal/oanda/v3-trade',
      logTag: 'QUALIFIED_V3_TRADE',
      payloadKey: 'trade',
      requireLive: false,
      extraBody: {
        signal: { ...signal, pair },
        executionSource: 'qualified_signal_button_v3',
      },
      afterCall: auditExecution({ engine, signal, pair }),
    });
  }

  if (engine === 'ict') {
    const direction = normalizeDirection(signal);
    const entry = finite(signal.entry);
    const stopLoss = finite(signal.stopLoss);
    const targetProfit = finite(signal.target1 ?? signal.targetProfit ?? signal.takeProfit);
    const ictSignalId = String(signal.signalId ?? signal.ictSignalId ?? '').trim();

    if (!direction || entry === null || stopLoss === null || targetProfit === null || !ictSignalId) {
      return NextResponse.json(
        { ok: false, error: 'Qualified ICT signal is missing direction, entry, stop loss, target, or signal id' },
        { status: 400 },
      );
    }

    return callScannerForCurrentUser({
      internalPath: '/api/internal/oanda/ict/trade',
      logTag: 'QUALIFIED_ICT_TRADE',
      payloadKey: 'trade',
      requireLive: false,
      extraBody: {
        pair,
        direction,
        entry,
        stopLoss,
        targetProfit,
        ictSignalId,
        executionSource: 'qualified_signal_button_ict',
      },
      afterCall: auditExecution({ engine, signal, pair }),
    });
  }

  const direction = normalizeDirection(signal);
  if (!direction) {
    return NextResponse.json({ ok: false, error: 'Qualified PPR signal is missing direction' }, { status: 400 });
  }

  // PPR owns its authoritative refresh. Re-run only the selected pair through the
  // existing engine-routed internal endpoint, which refreshes the candidate and
  // executes only when the current PPR signal remains qualified.
  return callScannerForCurrentUser({
    internalPath: '/api/internal/oanda/auto',
    logTag: 'QUALIFIED_PPR_TRADE',
    payloadKey: 'trade',
    requireLive: false,
    extraBody: {
      engine: 'ppr',
      scanMode: 'full',
      pairs: [pair],
      runId: `manual-ppr-${Date.now()}`,
      requestedDirection: direction,
      executionSource: 'qualified_signal_button_ppr',
    },
    afterCall: auditExecution({ engine, signal, pair }),
  });
}
