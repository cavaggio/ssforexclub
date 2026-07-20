import { NextResponse } from 'next/server';
import { callScannerForCurrentUser } from '@/lib/scannerProxy';

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
  });
}
