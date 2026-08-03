const finitePrice = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Select the bid/ask that can actually open a new OANDA position.
 *
 * OANDA documents closeoutBid/closeoutAsk as fallback prices for closing a
 * position when normal liquidity is unavailable; they are never used to open a
 * new position. Execution spread checks must therefore use the first available
 * bid/ask PriceBucket (or an already-normalized bid/ask object), not closeout
 * prices that can be materially wider.
 */
export function selectExecutableQuote(quote = {}) {
  const bid = finitePrice(quote?.bids?.[0]?.price ?? quote?.bid);
  const ask = finitePrice(quote?.asks?.[0]?.price ?? quote?.ask);
  const closeoutBid = finitePrice(quote?.closeoutBid);
  const closeoutAsk = finitePrice(quote?.closeoutAsk);

  if (bid === null || ask === null) {
    return {
      ok: false,
      source: 'top_of_book',
      reason: 'top-of-book bid/ask liquidity is unavailable',
      bid,
      ask,
      closeoutBid,
      closeoutAsk,
    };
  }

  if (ask < bid) {
    return {
      ok: false,
      source: 'top_of_book',
      reason: `invalid top-of-book quote: ask ${ask} is below bid ${bid}`,
      bid,
      ask,
      closeoutBid,
      closeoutAsk,
    };
  }

  return {
    ok: true,
    source: 'top_of_book',
    bid,
    ask,
    mid: (bid + ask) / 2,
    spread: ask - bid,
    closeoutBid,
    closeoutAsk,
  };
}
