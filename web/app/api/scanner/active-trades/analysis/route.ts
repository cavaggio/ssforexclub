/**
 * Authenticated active-trade analysis endpoint.
 *
 * OANDA/Alpaca keep the existing Railway analysis path. FTMO reads the open
 * position snapshot directly from the connected MT5 EA so selecting FTMO does
 * not try to use an OANDA execution account.
 */

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { callScannerForCurrentUser } from '@/lib/scannerProxy';
import { resolveActiveBrokerForUser } from '@/lib/brokerResolver';
import { getFtmoPositionsForUser, mt5SymbolToSignalPair } from '@/lib/ftmoPositions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function pipSize(pair: string): number {
  return pair.includes('JPY') ? 0.01 : 0.0001;
}

function ftmoTrade(position: Awaited<ReturnType<typeof getFtmoPositionsForUser>>['positions'][number]) {
  const pair = mt5SymbolToSignalPair(position.symbol);
  const pip = pipSize(pair);
  const entry = position.entryPrice;
  const current = position.currentPrice || entry;
  const isLong = position.side === 'long';
  const unrealizedPips = pip > 0
    ? (isLong ? current - entry : entry - current) / pip
    : 0;
  const distanceToTPPips = position.takeProfit == null || pip <= 0
    ? 0
    : Math.max(0, (isLong ? position.takeProfit - current : current - position.takeProfit) / pip);
  const distanceToSLPips = position.stopLoss == null || pip <= 0
    ? 0
    : Math.max(0, (isLong ? current - position.stopLoss : position.stopLoss - current) / pip);
  const totalTargetPips = position.takeProfit == null || pip <= 0
    ? 18
    : Math.max(0.0001, Math.abs(position.takeProfit - entry) / pip);
  const tpProgress = Math.max(0, Math.min(100, (unrealizedPips / totalTargetPips) * 100));
  const openTimeMs = position.openTime ? new Date(position.openTime).getTime() : NaN;
  const minutesElapsed = Number.isFinite(openTimeMs)
    ? Math.max(0, Math.round((Date.now() - openTimeMs) / 60_000))
    : 0;

  return {
    tradeId: position.ticket,
    instrument: pair,
    side: position.side,
    units: position.volume,
    entryPrice: entry,
    currentPrice: current,
    openTime: position.openTime || new Date().toISOString(),
    minutesElapsed,
    unrealizedPL: position.profit,
    unrealizedPips,
    stopLoss: position.stopLoss,
    takeProfit: position.takeProfit,
    distanceToTPPips,
    distanceToSLPips,
    tpProgress,
    // FTMO trade protection is broker-side in the EA. We deliberately do not
    // invent OANDA waterfall scores for an MT5 position.
    currentAlignmentScore: 0,
    currentConfidence: 0,
    tradeState: 'OPEN_HEALTHY',
    exitRecommendation: 'HOLD',
    exitReason: 'FTMO position is managed by SignalStackBridge broker-side protection (SL10 / BE10 / 80%@15 / 20%@18).',
    timeDecayRisk: 'low',
    updatedHoldWindow: { minMinutes: 0, maxMinutes: 0, holdConfidence: 0 },
    tpProbability: 0,
    slProbability: 0,
    macroOpposes: false,
    conflictingTfCount: 0,
    alignmentDropped: false,
    waterfall: null,
    source: 'ftmo_mt5',
    brokerManaged: true,
  };
}

export async function POST() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthenticated' }, { status: 401 });
  }

  const resolved = await resolveActiveBrokerForUser(userId);
  if (resolved.activeBroker !== 'ftmo') {
    return callScannerForCurrentUser({
      internalPath: '/api/internal/oanda/active-trades/analysis',
      logTag: 'SCANNER_ANALYSIS',
      payloadKey: 'analysis',
    });
  }

  try {
    const snapshot = await getFtmoPositionsForUser(userId);
    const trades = snapshot.positions.map(ftmoTrade);
    const detailPending = snapshot.positionCount > 0 && !snapshot.detailAvailable;

    return NextResponse.json({
      ok: true,
      activeBroker: 'ftmo',
      activeEnvironment: resolved.activeEnvironment,
      executionTransport: 'mt5_ea',
      analysis: {
        trades,
        meta: {
          scannedAt: new Date().toISOString(),
          session: 'FTMO / MT5',
          totalActive: snapshot.positionCount,
          autoCloseEnabled: false,
          notice: detailPending
            ? `MT5 reports ${snapshot.positionCount} open position(s). The current EA build only returned the count; detailed position cards will populate after the detailed position snapshot is available.`
            : snapshot.positionCount === 0
              ? 'No open FTMO positions on the connected MT5 account.'
              : 'Live positions sourced directly from the connected FTMO MT5 EA. Broker-side protection remains authoritative.',
        },
      },
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
