function envNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function minimumExecutableRR() {
  return envNumber(
    process.env.FOREX_MIN_EXECUTABLE_RR || process.env.FOREX_V3_PROMOTE_MIN_RR,
    1.5
  );
}

export function normalizeV3Direction(value) {
  const v = String(value || '').toLowerCase();
  if (v === 'buy') return 'long';
  if (v === 'sell') return 'short';
  return v === 'long' || v === 'short' ? v : null;
}

function pipSize(pair = '') {
  if (String(pair).includes('JPY')) return 0.01;
  if (pair === 'XAU_USD' || pair === 'XAG_USD') return 0.01;
  return 0.0001;
}

function roundPrice(price, pair = '') {
  return Number.isFinite(price)
    ? Number(price.toFixed(String(pair).includes('JPY') ? 3 : 5))
    : null;
}

function targetForRR(v3 = {}, minRR = 1.5) {
  const stopPips = Math.abs(Number(v3?.slPipsEst));
  if (!Number.isFinite(stopPips) || stopPips <= 0) return null;
  return [v3?.targets?.tp1, v3?.targets?.tp2, v3?.targets?.tp3]
    .filter(Boolean)
    .find((target) => Math.abs(Number(target?.pips)) / stopPips >= minRR) || null;
}

export function firstFinite(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return NaN;
}

export function buildV3Candidate(item = {}, v3 = {}, minRR = minimumExecutableRR()) {
  const pair = item?.pair || v3?.pair;
  const direction = normalizeV3Direction(item?.direction || v3?.direction || v3?.signal);
  const entry = firstFinite(item?.entry, item?.entryPrice, item?.currentPrice, v3?.entry, v3?.entryPrice);
  const stopPips = Math.abs(Number(v3?.slPipsEst));
  const target = targetForRR(v3, minRR);
  if (!pair || !direction || !Number.isFinite(entry) || !target || !Number.isFinite(stopPips)) return null;

  const stopLoss = direction === 'long'
    ? roundPrice(entry - stopPips * pipSize(pair), pair)
    : roundPrice(entry + stopPips * pipSize(pair), pair);
  const takeProfit = roundPrice(Number(target.price), pair);
  const rewardPips = Math.abs(Number(target.pips));
  const rr = +(rewardPips / stopPips).toFixed(2);
  if (!Number.isFinite(stopLoss) || !Number.isFinite(takeProfit) || rr < minRR) return null;

  return {
    pair, direction, entry, entryPrice: entry, stopLoss,
    targetProfit: takeProfit, takeProfit, expectedRR: rr, rr,
    stopLossPips: +stopPips.toFixed(1),
    takeProfitPips: +rewardPips.toFixed(1),
    lifecycle: {
      allowed: true,
      sl: { stopLossPips: +stopPips.toFixed(1), stopLossPrice: stopLoss,
        invalidationReason: 'V3 promoted liquidity/invalidation stop' },
      tp: { allowed: true, takeProfitPips: +rewardPips.toFixed(1), takeProfitPrice: takeProfit,
        targetReason: `V3 promoted target from ${target.source || 'liquidity'}`,
        targetSource: target.source || 'v3_liquidity' },
      source: 'v3_promoted_lifecycle',
    },
  };
}
