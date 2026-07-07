from pathlib import Path

p = Path("server/edgeIntelligence.js")
txt = p.read_text()

start = txt.index("export function buildTradeEdgeSnapshot(trade) {")
end = txt.index("\n// ─── Aggregation core", start)

new_func = r"""export function buildTradeEdgeSnapshot(trade) {
  if (!trade || typeof trade !== 'object') return null;

  const eventType = String(
    trade.status ||
    trade.event ||
    trade.event_type ||
    trade.type ||
    trade.action ||
    ''
  ).trim().toLowerCase();

  // Ignore backend reassessment snapshots. They are unrealized mark-to-market
  // updates, not final trade outcomes.
  if (['reassessed', 'reassessment', 'updated', 'mark_to_market'].includes(eventType)) {
    return null;
  }

  const rawPayload = parseJsonObject(trade.raw_payload || trade.rawPayload || trade.payload);
  const rawResult = parseJsonObject(trade.result_payload || trade.resultPayload);
  const closeResult = parseJsonObject(
    rawPayload.closeResult ||
    rawPayload.close_result ||
    rawPayload.close ||
    rawPayload.result ||
    rawResult
  );

  const rawPayloadSignal =
    rawPayload.signal ||
    rawPayload.trade?.signal ||
    rawPayload.order?.signal ||
    trade.raw_payload?.signal ||
    trade.rawPayload?.signal ||
    {};

  const sig = Object.keys(rawPayloadSignal || {}).length ? rawPayloadSignal : trade;
  const macro = trade.macroAnalysis || rawPayload.macroAnalysis || sig.macroAnalysis || {};
  const regime = trade.marketRegime || rawPayload.marketRegime || sig.marketRegime || {};
  const sigMacro = sig.macroAnalysis || macro;
  const sigRegime = sig.marketRegime || regime;

  const sourceObjects = [
    trade,
    closeResult,
    rawResult,
    rawPayload,
    rawPayload.trade,
    rawPayload.order,
    rawPayload.execution,
    rawPayload.close,
    sig,
  ].filter(Boolean);

  const pnl = toNum(firstDeepDefined(sourceObjects, [
    'pnl',
    'realized_pnl',
    'realizedPnl',
    'realized_pl',
    'realizedPL',
    'realizedPl',
    'profit',
    'profit_loss',
    'profitLoss',
    'pl',
    'closePnl',
    'close_pnl',
  ]));

  let winLoss = normalizeOutcome(firstDeepDefined(sourceObjects, [
    'winLoss',
    'win_loss',
    'result',
    'outcome',
    'status',
    'state',
  ]));

  if (!winLoss && pnl != null) {
    winLoss = pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'breakeven';
  }

  const volatility =
    firstDeepDefined(sourceObjects, ['volatility', 'volatilityState', 'volatility_state']) ||
    sigRegime?.volatility?.state ||
    (typeof sigRegime?.volatility === 'string' ? sigRegime.volatility : null);

  return {
    pair: firstDeepDefined(sourceObjects, ['pair', 'instrument', 'symbol']),
    direction: normDirection(firstDeepDefined(sourceObjects, ['direction', 'side', 'tradeSide'])),
    entryTime: toIso(firstDeepDefined(sourceObjects, [
      'entryTime',
      'entry_time',
      'openTime',
      'open_time',
      'openedAt',
      'opened_at',
      'timestamp',
      'created_at',
      'createdAt',
    ])),
    exitTime: toIso(firstDeepDefined(sourceObjects, [
      'exitTime',
      'exit_time',
      'closeTime',
      'close_time',
      'closedAt',
      'closed_at',
      'resolvedAt',
      'resolved_at',
      'updated_at',
      'updatedAt',
    ])),
    pnl,
    winLoss,
    session: firstDeepDefined(sourceObjects, ['session', 'entrySession', 'entry_session']),
    spread: toNum(firstDeepDefined(sourceObjects, ['spread', 'spreadPips', 'entrySpreadPips', 'entry_spread_pips'])),
    confidence: toNum(firstDeepDefined(sourceObjects, ['confidence'])),
    signalScore: toNum(firstDeepDefined(sourceObjects, ['signalScore', 'signal_score', 'score'])),
    trend: firstDeepDefined(sourceObjects, ['trend']) || sig.trend || null,
    volatility: volatility || null,
    marketRegime: (() => {
      const raw = firstDeepDefined(sourceObjects, ['marketRegime', 'market_regime']);
      if (typeof raw === 'string') return raw;
      if (raw && typeof raw === 'object') return raw.regime || raw.state || null;
      return sigRegime?.regime || null;
    })(),
    macroBias:
      firstDeepDefined(sourceObjects, ['macroBias', 'macro_bias']) ||
      sigMacro?.bias ||
      null,
    macroRisk:
      firstDeepDefined(sourceObjects, ['macroRisk', 'macro_risk']) ||
      sigMacro?.risk ||
      null,
  };
}
"""

txt = txt[:start] + new_func + txt[end:]
p.write_text(txt)

print("Repaired buildTradeEdgeSnapshot()")
