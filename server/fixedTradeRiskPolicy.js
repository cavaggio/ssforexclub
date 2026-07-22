import { getPipSize } from './oandaRiskSizing.js';

export const FIXED_RISK_PER_TRADE_PERCENT = 1.25;
export const FIXED_STOP_LOSS_PIPS = 20;

export function priceDecimalsForPair(pair) {
  if (pair === 'XAU_USD' || pair === 'XAG_USD') return 2;
  return String(pair || '').includes('JPY') ? 3 : 5;
}

function roundPrice(value, decimals) {
  return Number(Number(value).toFixed(decimals));
}

/**
 * Final execution geometry. Upstream engines may propose structure-aware levels,
 * but every submitted OANDA trade receives an exact 20-pip stop. The proposed TP
 * is retained only when it is directionally valid and at least minRR away;
 * otherwise it is extended to the minimum executable R:R.
 */
export function enforceFixedStopGeometry({
  pair,
  direction,
  entry,
  takeProfit,
  minRR = 1.5,
  priceDecimals = priceDecimalsForPair(pair),
} = {}) {
  const entryPrice = Number(entry);
  const proposedTp = Number(takeProfit);
  const pipSize = getPipSize(pair);

  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    throw new Error('Fixed risk policy requires a finite positive entry price.');
  }
  if (direction !== 'long' && direction !== 'short') {
    throw new Error('Fixed risk policy requires direction long or short.');
  }

  const stopLossPips = FIXED_STOP_LOSS_PIPS;
  const minimumTakeProfitPips = stopLossPips * Math.max(1.5, Number(minRR) || 1.5);
  const proposedTpIsValid = Number.isFinite(proposedTp) && (
    direction === 'long' ? proposedTp > entryPrice : proposedTp < entryPrice
  );
  const proposedTpPips = proposedTpIsValid
    ? Math.abs(proposedTp - entryPrice) / pipSize
    : 0;
  const takeProfitPips = Math.max(minimumTakeProfitPips, proposedTpPips);

  const stopLoss = direction === 'long'
    ? entryPrice - stopLossPips * pipSize
    : entryPrice + stopLossPips * pipSize;
  const finalTakeProfit = direction === 'long'
    ? entryPrice + takeProfitPips * pipSize
    : entryPrice - takeProfitPips * pipSize;

  return {
    entry: roundPrice(entryPrice, priceDecimals),
    stopLoss: roundPrice(stopLoss, priceDecimals),
    takeProfit: roundPrice(finalTakeProfit, priceDecimals),
    stopLossPips,
    takeProfitPips: +(takeProfitPips.toFixed(1)),
    riskReward: +(takeProfitPips / stopLossPips).toFixed(2),
    pipSize,
    priceDecimals,
  };
}

/**
 * OANDA applies distance from the actual market fill, not a stale signal price.
 * This guarantees the attached stop is exactly 20 pips from the broker fill.
 */
export function buildFixedStopLossOnFill({ pair, priceDecimals = priceDecimalsForPair(pair) } = {}) {
  const distance = FIXED_STOP_LOSS_PIPS * getPipSize(pair);
  return {
    distance: distance.toFixed(priceDecimals),
    timeInForce: 'GTC',
  };
}

/**
 * P/L is realized in the instrument quote currency. Ask OANDA for the loss-side
 * quote-to-home conversion factor so cross pairs such as EUR_CHF are not sized as
 * though one CHF always equals one account-currency unit.
 */
export async function getLossQuoteHomeConversionFactor({
  pair,
  client,
  homeCurrency = 'USD',
} = {}) {
  const normalizedPair = String(pair || '').toUpperCase();
  const quoteCurrency = normalizedPair.split('_')[1];
  const normalizedHome = String(homeCurrency || 'USD').toUpperCase();
  if (!quoteCurrency) throw new Error(`Invalid instrument for risk conversion: ${pair}`);

  // No broker call is required when P/L is already denominated in the account
  // currency (for example EUR_USD in a USD account).
  if (quoteCurrency === normalizedHome) return 1;

  if (!client || typeof client.get !== 'function') {
    throw new Error('Missing request-scoped OANDA client for home-currency risk conversion.');
  }

  const accountId = client.accountId || client.accountID || client.account_id;
  if (!accountId) throw new Error('Missing OANDA accountId for home-currency risk conversion.');

  const path =
    `/v3/accounts/${accountId}/pricing?instruments=${encodeURIComponent(normalizedPair)}` +
    `&includeHomeConversions=true`;
  const response = await client.get(path);
  const payload = response?.data ?? response;
  const conversion = (payload?.homeConversions || []).find(
    (row) => String(row?.currency || '').toUpperCase() === quoteCurrency,
  );
  const price = (payload?.prices || []).find((row) => row?.instrument === normalizedPair);

  const factor = Number(
    conversion?.accountLoss ??
    price?.quoteHomeConversionFactors?.negativeUnits ??
    price?.quoteHomeConversionFactors?.positiveUnits,
  );

  if (!Number.isFinite(factor) || factor <= 0) {
    throw new Error(
      `OANDA did not provide a valid ${quoteCurrency}->${normalizedHome} loss conversion factor for ${normalizedPair}.`,
    );
  }

  return factor;
}
