const PPR_ALLOWED_PAIRS = new Set(['GBP_JPY', 'EUR_GBP', 'GBP_USD']);

export function normalizeScanEngine(value) {
  const engine = String(value || 'ict').toLowerCase();
  if (engine === 'v3' || engine === 'ppr') return engine;
  return 'ict';
}

export function scanEndpointForEngine(value) {
  const engine = normalizeScanEngine(value);
  if (engine === 'ppr') {
    return { engine, internalPath: '/api/internal/oanda/ppr-scan', logTag: 'PPR_SCANNER_SCAN' };
  }
  if (engine === 'v3') {
    return { engine, internalPath: '/api/internal/oanda/v3-scan', logTag: 'V3_SCANNER_SCAN' };
  }
  return { engine: 'ict', internalPath: '/api/internal/oanda/ict', logTag: 'ICT_SCANNER_SCAN' };
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function text(value, fallback = '') {
  if (typeof value === 'string') return value;
  if (value == null) return fallback;
  try { return String(value); } catch { return fallback; }
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeSession(value) {
  if (typeof value === 'string') return { name: value, details: null };
  const details = object(value);
  const name = text(details.name || details.session || details.label, 'PPR session');
  return { name, details: Object.keys(details).length ? details : null };
}

function normalizePprItem(value, fallbackStatus) {
  const item = object(value);
  const pair = text(item.pair || item.instrument).trim().toUpperCase();
  if (!PPR_ALLOWED_PAIRS.has(pair)) return null;
  const session = normalizeSession(item.session);
  const ppr = object(item.ppr);
  const confirmation = object(item.pprConfirmation);
  const lifecycle = object(item.lifecycle);
  const liquidityPools = object(item.liquidityPools || ppr.liquidityPools);

  return {
    pair,
    engine: 'ppr',
    strategy: 'PPR',
    source: 'ppr_auto_ai',
    architecture: 'independent_ppr_raw_market_data',
    legacyScannerUsed: false,
    v3LogicUsed: false,
    ictLogicUsed: false,
    status: text(item.status, fallbackStatus || 'rejected').toLowerCase(),
    reason: text(item.reason),
    direction: item.direction === 'long' || item.direction === 'short' ? item.direction : null,
    entry: numberOrNull(item.entry ?? item.entryPrice),
    entryPrice: numberOrNull(item.entryPrice ?? item.entry),
    currentPrice: numberOrNull(item.currentPrice ?? item.entry ?? item.entryPrice),
    stopLoss: numberOrNull(item.stopLoss),
    takeProfit: numberOrNull(item.takeProfit),
    rr: numberOrNull(item.rr ?? item.expectedRR),
    expectedRR: numberOrNull(item.expectedRR ?? item.rr),
    confidence: numberOrNull(item.confidence),
    entryQualityConfidence: numberOrNull(item.entryQualityConfidence ?? item.confidence),
    spreadPips: numberOrNull(item.spreadPips ?? object(item.pricing).spreadPips),
    atrPips: numberOrNull(item.atrPips),
    session: session.name,
    sessionDetails: session.details,
    dailyBias: object(item.dailyBias || ppr.dailyBias),
    h1Alignment: object(item.h1Alignment || ppr.h1Alignment),
    volume: object(item.volume || ppr.volume),
    manipulation: object(item.manipulation || ppr.manipulation),
    manipulationCandidates: Array.isArray(item.manipulationCandidates)
      ? item.manipulationCandidates
      : Array.isArray(ppr.manipulationCandidates) ? ppr.manipulationCandidates : [],
    liquidityPools,
    liquidityTarget: object(item.liquidityTarget || ppr.liquidityTarget),
    ppr,
    pprConfirmation: confirmation,
    lifecycle,
    management: object(item.management || lifecycle.management),
    hold: object(item.hold || lifecycle.hold),
    newsPolicy: object(item.newsPolicy),
  };
}

function normalizePprArray(value, fallbackStatus) {
  return Array.isArray(value)
    ? value.map((item) => normalizePprItem(item, fallbackStatus)).filter(Boolean)
    : [];
}

export function normalizePprScan(rawValue) {
  const raw = object(rawValue);
  const qualified = normalizePprArray(raw.qualified, 'qualified');
  const watchCandidates = normalizePprArray(raw.watchCandidates, 'near');
  const rejected = normalizePprArray(raw.rejected, 'rejected');
  const meta = object(raw.meta);
  const qualifiedCount = qualified.length;
  const watchCount = watchCandidates.length;
  const rejectedCount = rejected.length;
  const accountedFor = qualifiedCount + watchCount + rejectedCount;
  const pairsScanned = numberOrNull(meta.pairsScanned) ?? accountedFor;
  const countInvariantOk = pairsScanned === accountedFor;

  return {
    engine: 'ppr',
    architecture: 'independent_ppr_raw_market_data',
    scanner: 'ppr_independent',
    calculationSource: 'independent_ppr_raw_market_data',
    legacyScannerUsed: false,
    v3LogicUsed: false,
    ictLogicUsed: false,
    watchlist: ['GBP_JPY', 'EUR_GBP', 'GBP_USD'],
    qualified,
    watchCandidates,
    rejected,
    meta: {
      ...meta,
      scanner: 'ppr_independent',
      calculationSource: 'independent_ppr_raw_market_data',
      pairsScanned,
      qualifiedCount,
      watchCount,
      rejectedCount,
      accountedFor,
      countInvariantOk,
      minConfidence: numberOrNull(meta.minConfidence) ?? 75,
      minRR: numberOrNull(meta.minRR) ?? 1.5,
      managementCutoffEt: text(meta.managementCutoffEt, '10:00'),
      afterCutoff: text(meta.afterCutoff, 'manual_only'),
      legacyScannerUsed: false,
      v3LogicUsed: false,
      ictLogicUsed: false,
    },
  };
}

function normalizeIctItem(value, thresholds) {
  const item = object(value);
  const signal = text(item.signal, 'none').toLowerCase();
  const directional = signal === 'buy' || signal === 'sell' || signal === 'long' || signal === 'short';
  const direction = signal === 'buy' || signal === 'long'
    ? 'long'
    : signal === 'sell' || signal === 'short'
      ? 'short'
      : null;
  const confidence = numberOrNull(item.confidence);
  const rr = numberOrNull(item.rr ?? item.riskReward ?? item.expectedRR);
  const minConfidence = numberOrNull(thresholds?.minConfidence) ?? 75;
  const minRR = numberOrNull(thresholds?.minRR) ?? 1.5;
  const rejectionReasons = Array.isArray(item.rejectionReasons)
    ? item.rejectionReasons.map((reason) => text(reason)).filter(Boolean)
    : [];

  if (directional && !(confidence != null && confidence >= minConfidence)) {
    rejectionReasons.push(`ICT confidence below execution threshold (${confidence ?? 'n/a'} < ${minConfidence}).`);
  }
  if (directional && !(rr != null && rr >= minRR)) {
    rejectionReasons.push(`ICT risk/reward below execution threshold (${rr ?? 'n/a'} < ${minRR}).`);
  }

  const qualified = directional &&
    confidence != null && confidence >= minConfidence &&
    rr != null && rr >= minRR;
  const narrative = text(item.ictNarrative);

  return {
    ...item,
    v3Comparison: undefined,
    engine: 'ict',
    architecture: 'independent_ict_raw_market_data',
    status: qualified ? 'qualified' : 'rejected',
    direction,
    confidence,
    rr,
    reason: qualified ? narrative : rejectionReasons.join('; ') || narrative,
    rejectionReasons,
    executionThresholds: { minConfidence, minRR },
  };
}

export function normalizeIctScan(rawValue) {
  const raw = object(rawValue);
  const meta = object(raw.meta);
  const executionThresholds = {
    minConfidence: numberOrNull(meta.executionMinConfidence ?? meta.minConfidence) ?? 75,
    minRR: numberOrNull(meta.executionMinRR ?? meta.minRR) ?? 1.5,
  };
  const analyses = Array.isArray(raw.analyses)
    ? raw.analyses.map((item) => normalizeIctItem(item, executionThresholds))
    : [];
  return {
    engine: 'ict',
    architecture: 'independent_ict_raw_market_data',
    scanner: 'ict_independent',
    calculationSource: 'independent_ict_raw_market_data',
    qualified: analyses.filter((item) => item.status === 'qualified'),
    watchCandidates: [],
    rejected: analyses.filter((item) => item.status !== 'qualified'),
    analyses,
    meta: {
      ...meta,
      executionMinConfidence: executionThresholds.minConfidence,
      executionMinRR: executionThresholds.minRR,
      scanner: 'ict_independent',
      calculationSource: 'independent_ict_raw_market_data',
    },
  };
}

export function normalizeV3Scan(rawValue) {
  const raw = object(rawValue);
  return {
    ...raw,
    engine: 'v3',
    architecture: text(raw.architecture, 'independent_v3_raw_market_data'),
    scanner: text(raw.scanner || object(raw.meta).scanner, 'v3_independent'),
    qualified: Array.isArray(raw.qualified) ? raw.qualified : [],
    watchCandidates: Array.isArray(raw.watchCandidates) ? raw.watchCandidates : [],
    rejected: Array.isArray(raw.rejected) ? raw.rejected : [],
    meta: object(raw.meta),
  };
}

export function normalizeSelectedScan(engineValue, rawValue) {
  const engine = normalizeScanEngine(engineValue);
  if (engine === 'ppr') return normalizePprScan(rawValue);
  if (engine === 'v3') return normalizeV3Scan(rawValue);
  return normalizeIctScan(rawValue);
}

export const PPR_SCANNER_ALLOWED_PAIRS = Object.freeze(['GBP_JPY', 'EUR_GBP', 'GBP_USD']);
