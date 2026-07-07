from pathlib import Path

path = Path("server/edgeIntelligence.js")
txt = path.read_text()

# 1) Add deeper helpers after firstDefined()
needle = """function firstDefined(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return null;
}
"""

replacement = """function firstDefined(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return null;
}

function firstDeepDefined(objects, keys) {
  for (const obj of objects) {
    const v = firstDefined(obj, keys);
    if (v !== null && v !== undefined && v !== '') return v;
  }
  return null;
}

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeOutcome(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!s || s === 'pending' || s === 'open' || s === 'active') return null;
  if (['win', 'won', 'profit', 'tp', 'take_profit', 'take profit'].includes(s)) return 'win';
  if (['loss', 'lost', 'sl', 'stop_loss', 'stop loss'].includes(s)) return 'loss';
  if (['breakeven', 'break_even', 'break even', 'flat'].includes(s)) return 'breakeven';
  if (['closed', 'resolved', 'completed', 'complete', 'filled'].includes(s)) return null;
  return s;
}
"""

if needle not in txt:
    raise SystemExit("Could not find firstDefined() block. Open server/edgeIntelligence.js and patch manually.")

txt = txt.replace(needle, replacement)

# 2) Replace buildTradeEdgeSnapshot with a more tolerant version.
start = txt.index("export function buildTradeEdgeSnapshot(trade) {")
end = txt.index("\n// ─── Aggregation core", start)

new_func = r"""export function buildTradeEdgeSnapshot(trade) {
  if (!trade || typeof trade !== 'object') return null;

  // Supabase trade_logs commonly store the useful execution/close data inside
  // raw_payload/rawPayload/payload instead of top-level columns. Edge Intelligence
  // must normalize both shapes, otherwise the UI shows 0/0 resolved even when
  // trade_logs has plenty of completed close events.
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
    marketRegime:
      firstDeepDefined(sourceObjects, ['marketRegime', 'market_regime']) ||
      sigRegime?.regime ||
      null,
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
path.write_text(txt)

print("Patched server/edgeIntelligence.js")
