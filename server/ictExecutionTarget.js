import { getPipSize } from './pipMath.js';

const finite = (value, fallback = null) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizePair = (value) => String(value || '')
  .trim()
  .toUpperCase()
  .replaceAll('/', '_')
  .replaceAll('-', '_');

const priceDecimalsFor = (pair) => {
  const normalized = normalizePair(pair);
  if (normalized === 'XAU_USD' || normalized === 'XAG_USD') return 2;
  return normalized.includes('JPY') ? 3 : 5;
};

/**
 * Select the quote that belongs to the requested pair instead of blindly using
 * prices[0]. OANDA normally returns one item for a one-instrument request, but
 * mocks, adapters, retries, and future batching can return multiple instruments.
 */
export function selectIctPairQuote(pricingPayload, pair) {
  const requestedPair = normalizePair(pair);
  const direct = pricingPayload?.[requestedPair] ?? pricingPayload?.[pair];
  if (direct && typeof direct === 'object') {
    const quoteInstrument = normalizePair(direct.instrument || requestedPair);
    if (quoteInstrument === requestedPair) {
      return {
        ok: true,
        quote: direct,
        requestedPair,
        quoteInstrument,
        matchedBy: 'pair_key',
        candidateCount: 1,
      };
    }
  }

  const candidates = Array.isArray(pricingPayload)
    ? pricingPayload
    : Array.isArray(pricingPayload?.prices)
      ? pricingPayload.prices
      : pricingPayload && typeof pricingPayload === 'object'
        ? [pricingPayload]
        : [];

  const exact = candidates.find((quote) => normalizePair(quote?.instrument) === requestedPair);
  if (exact) {
    return {
      ok: true,
      quote: exact,
      requestedPair,
      quoteInstrument: requestedPair,
      matchedBy: 'instrument',
      candidateCount: candidates.length,
    };
  }

  // Some test clients and thin broker adapters omit the instrument when the
  // response contains exactly one quote. Accept that unambiguous shape only.
  if (candidates.length === 1 && !candidates[0]?.instrument) {
    return {
      ok: true,
      quote: candidates[0],
      requestedPair,
      quoteInstrument: null,
      matchedBy: 'single_unlabelled_quote',
      candidateCount: 1,
    };
  }

  const instruments = candidates
    .map((quote) => normalizePair(quote?.instrument))
    .filter(Boolean);
  return {
    ok: false,
    quote: null,
    requestedPair,
    quoteInstrument: instruments[0] || null,
    matchedBy: null,
    candidateCount: candidates.length,
    availableInstruments: instruments,
    reason: instruments.length
      ? `pricing response did not contain ${requestedPair}; received ${instruments.join(', ')}`
      : `pricing response did not contain a labelled quote for ${requestedPair}`,
  };
}

/**
 * Preserve the configured minimum R:R when a fresh executable bid/ask moves a
 * scanner-qualified setup before submission.
 *
 * The scanner must already satisfy the configured R:R floor and the fresh quote
 * must still have valid entry/SL/TP geometry. If the fresh executable price has
 * consumed reward, the TP is automatically moved outward to restore the floor.
 * `maxExtensionPips` is retained as an observability/advisory threshold only;
 * exceeding it is no longer an execution disqualifier for an otherwise-valid
 * qualified ICT setup.
 */
export function maybeRebaseIctTarget({
  pair,
  direction,
  executablePrice,
  stopLoss,
  currentTarget,
  scannerRR,
  executableRR,
  minimumRR = 1.5,
  maxExtensionPips = 5,
} = {}) {
  const normalizedPair = normalizePair(pair);
  const entry = finite(executablePrice);
  const stop = finite(stopLoss);
  const target = finite(currentTarget);
  const scanned = finite(scannerRR, 0);
  const quoted = finite(executableRR, 0);
  const floor = Math.max(1.5, finite(minimumRR, 1.5));
  const extensionLimit = Math.max(0, finite(maxExtensionPips, 5));
  const isLong = direction === 'long' || direction === 'buy';
  const isShort = direction === 'short' || direction === 'sell';

  const base = {
    pair: normalizedPair,
    adjusted: false,
    targetProfit: target,
    originalTarget: target,
    scannerRR: scanned,
    executableRR: quoted,
    minimumRR: floor,
    shortfallR: Math.max(0, floor - quoted),
    extensionPips: 0,
    extensionLimitPips: extensionLimit,
    extensionCapExceeded: false,
    advisory: null,
    blocker: null,
  };

  if ((!isLong && !isShort) || ![entry, stop, target].every(Number.isFinite)) {
    return {
      ...base,
      reason: 'invalid_inputs',
      blocker: `${normalizedPair || 'ICT pair'} executable target inputs are invalid`,
    };
  }
  const geometryValid = isLong
    ? stop < entry && target > entry
    : stop > entry && target < entry;
  if (!geometryValid) {
    return {
      ...base,
      reason: 'invalid_geometry',
      blocker: `${normalizedPair} executable entry/SL/TP geometry is invalid`,
    };
  }
  if (scanned < floor) {
    return {
      ...base,
      reason: 'scanner_rr_below_floor',
      blocker: `${normalizedPair} scanner R:R ${scanned.toFixed(2)} is below ${floor.toFixed(2)}`,
    };
  }
  if (quoted >= floor) return { ...base, reason: 'rebase_not_needed' };
  if (!(quoted > 0)) {
    return {
      ...base,
      reason: 'invalid_executable_rr',
      blocker: `${normalizedPair} executable R:R could not be calculated from its fresh quote`,
    };
  }

  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) {
    return {
      ...base,
      reason: 'invalid_risk_distance',
      blocker: `${normalizedPair} executable stop distance is invalid`,
    };
  }

  const dp = priceDecimalsFor(normalizedPair);
  const tick = 10 ** (-dp);
  const rawTarget = isLong
    ? entry + risk * floor
    : entry - risk * floor;
  const scaled = rawTarget / tick;
  const outwardTicks = isLong
    ? Math.ceil(scaled - 1e-9)
    : Math.floor(scaled + 1e-9);
  const rebasedTarget = Number((outwardTicks * tick).toFixed(dp));
  const pip = getPipSize(normalizedPair);
  const extensionPips = pip > 0 ? Math.abs(rebasedTarget - target) / pip : Infinity;
  if (!Number.isFinite(extensionPips)) {
    return {
      ...base,
      reason: 'target_extension_unavailable',
      blocker: `${normalizedPair} required TP extension could not be calculated`,
    };
  }

  const rebasedReward = Math.abs(rebasedTarget - entry);
  const rebasedRR = rebasedReward / risk;
  if (rebasedRR + 1e-9 < floor) {
    return {
      ...base,
      reason: 'rebased_rr_below_floor',
      blocker: `${normalizedPair} rounded executable target remains below ${floor.toFixed(2)}R`,
    };
  }

  const roundedExtension = +extensionPips.toFixed(2);
  const extensionCapExceeded = roundedExtension > extensionLimit;
  return {
    ...base,
    adjusted: true,
    targetProfit: rebasedTarget,
    rebasedRR: +rebasedRR.toFixed(2),
    extensionPips: roundedExtension,
    extensionCapExceeded,
    advisory: extensionCapExceeded
      ? `${normalizedPair} TP auto-adjustment ${roundedExtension.toFixed(2)}p exceeds the prior ${extensionLimit.toFixed(2)}p advisory threshold`
      : null,
    reason: extensionCapExceeded
      ? 'fresh_quote_minimum_rr_preserved_above_advisory_cap'
      : 'fresh_quote_minimum_rr_preserved',
  };
}
