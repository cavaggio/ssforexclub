from pathlib import Path

p = Path("server/ictExecution.js")
txt = p.read_text()

# Add getPricing import if not already present.
txt = txt.replace(
"import { getAccountSummary, getCandles, getOpenTrades } from './oandaMarketData.js';",
"import { getAccountSummary, getCandles, getOpenTrades, getPricing } from './oandaMarketData.js';"
)

# Add helper after priceDecimalsFor.
needle = "const priceDecimalsFor = (p) => (isMetal(p) ? 2 : String(p).includes('JPY') ? 3 : 5);\n"
helper = r"""
function quoteMidPrice(q) {
  // Opening orders must use the actual top-of-book PriceBuckets. OANDA's
  // closeoutBid/closeoutAsk are fallback close-position prices and are never
  // used to open a new position, so they must not drive entry spread checks.
  const bid = Number(q?.bids?.[0]?.price ?? q?.bid);
  const ask = Number(q?.asks?.[0]?.price ?? q?.ask);
  if (Number.isFinite(bid) && Number.isFinite(ask)) return { bid, ask, mid: (bid + ask) / 2, spread: ask - bid };
  return { bid: null, ask: null, mid: null, spread: null };
}

function validateFreshProtectivePrices({ pair, direction, quote, stopLoss, targetProfit }) {
  const pipSize = getPipSize(pair);
  const bufferPips = Number(process.env.ICT_EXECUTION_PRICE_BUFFER_PIPS || 2);
  const minBuffer = pipSize * bufferPips;

  const { bid, ask, mid, spread } = quoteMidPrice(quote);
  const executable = direction === 'long' ? ask : bid;

  if (!Number.isFinite(executable)) {
    return {
      ok: false,
      reason: `Could not read fresh executable ${direction === 'long' ? 'ask' : 'bid'} price for ${pair}.`,
      bid,
      ask,
      mid,
      spread,
    };
  }

  const ok = direction === 'long'
    ? stopLoss < executable - minBuffer && targetProfit > executable + minBuffer
    : stopLoss > executable + minBuffer && targetProfit < executable - minBuffer;

  if (!ok) {
    return {
      ok: false,
      reason:
        `Stale/invalid protective prices for ${direction} ${pair}: ` +
        `freshExecutable=${executable.toFixed(priceDecimalsFor(pair))}, ` +
        `SL=${stopLoss.toFixed(priceDecimalsFor(pair))}, ` +
        `TP=${targetProfit.toFixed(priceDecimalsFor(pair))}. ` +
        `Refusing order to avoid OANDA TAKE_PROFIT_ON_FILL_LOSS / STOP_LOSS_ON_FILL_LOSS.`,
      bid,
      ask,
      mid,
      spread,
    };
  }

  return { ok: true, bid, ask, mid, spread };
}
"""
if helper not in txt:
    txt = txt.replace(needle, needle + helper)

# Insert fresh pricing validation before order payload.
anchor = """  // ── 9. Place the order through the EXISTING OANDA client (atomic MARKET) ────
  const accountId = client.accountId || getAccountId();
  const dp = priceDecimalsFor(pair);
"""
insert = r"""  // ── 8d. Fresh executable price guard ───────────────────────────────────────
  // OANDA validates SL/TP-on-fill against the actual fill-side price, not the
  // stale signal entry shown in the UI. Recheck bid/ask immediately before submit
  // so we block stale targets instead of sending an order OANDA will cancel.
  let freshQuote = null;
  try {
    const pricing = await getPricing([pair], { client });
    freshQuote = Array.isArray(pricing) ? pricing[0] : pricing?.prices?.[0] || pricing?.[pair] || pricing;
  } catch (err) {
    rec(`blocked: fresh price check failed (${err.message})`);
    return blocked(`Fresh price check failed before execution: ${err.message}`);
  }

  const protectiveCheck = validateFreshProtectivePrices({
    pair,
    direction,
    quote: freshQuote,
    stopLoss,
    targetProfit,
  });

  if (!protectiveCheck.ok) {
    rec(`blocked: ${protectiveCheck.reason}`);
    return blocked(protectiveCheck.reason, { freshPrice: protectiveCheck });
  }

"""
if anchor not in txt:
    raise SystemExit("Could not find order payload anchor in server/ictExecution.js")

txt = txt.replace(anchor, insert + anchor)

p.write_text(txt)
print("Patched fresh TP/SL validation in server/ictExecution.js")
