/**
 * Authenticated active-trade analysis endpoint.
 *
 * OANDA/Alpaca keep the existing Railway analysis path. FTMO reads the open
 * position snapshot directly from the connected MT5 EA so selecting FTMO does
 * not try to use an OANDA execution account.
 *
 * MT5 sizing note: `volume` (lots) is the canonical FTMO size. `units` is
 * included only as a generic-dashboard compatibility field and is derived from
 * volume × broker contract size; it is never used for MT5 execution.
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
  const openTimeMs = position.openTimeEpochMs ?? (position.openTime ? new Date(position.openTime).getTime() : NaN);
  const minutesElapsed = Number.isFinite(openTimeMs)
    ? Math.max(0, Math.round((Date.now() - Number(openTimeMs)) / 60_000))
    : 0;

  return {
    tradeId: position.ticket,
    instrument: pair,
    side: position.side,

    // MT5-native broker sizing.
    volume: position.volume,
    sizeUnit: 'lots',
    volumeMin: position.volumeMin,
    volumeMax: position.volumeMax,
    volumeStep: position.volumeStep,
    contractSize: position.contractSize,
    notionalUnits: position.notionalUnits,

    // Compatibility for generic OANDA-oriented dashboard widgets. This is true
    // notional units, not MT5 volume mislabeled as units.
    units: position.notionalUnits ?? 0,

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
    managedBySignalStack: position.managedBySignalStack,
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
      positionSizeUnit: 'lots',
      analysis: {
        trades,
        meta: {
          scannedAt: new Date().toISOString(),
          session: 'FTMO / MT5',
          totalActive: snapshot.positionCount,
          autoCloseEnabled: false,
          positionSizeUnit: 'lots',
          notice: detailPending
            ? `MT5 reports ${snapshot.positionCount} open position(s). The attached EA has not yet returned the detailed v1.22 position snapshot.`
            : snapshot.positionCount === 0
              ? 'No open FTMO positions on the connected MT5 account.'
              : 'Live positions sourced directly from FTMO MT5. Position size is displayed in MT5 volume (lots); broker-side protection remains authoritative.',
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
