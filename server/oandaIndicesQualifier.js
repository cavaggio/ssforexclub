/**
 * server/oandaIndicesQualifier.js
 *
 * Dedicated qualification model for NAS100 / US30 / SPX500 / DE30 / UK100.
 *
 * Why indices need their own path:
 *   - Volume + volatility are concentrated in the NY cash session
 *     (13:30–20:00 UTC). Trades outside that window are noisy.
 *   - Indices "open with conviction" — the first NY hour often sets the day's
 *     direction. Reversal-against-NY-open is a low-probability trade.
 *   - Big-tech-heavy NAS100 has frequent overextension after an impulse run;
 *     chasing that move is the most common SL hit. Pullback/retest only.
 *   - US30 trends more steadily; we can be a touch less strict, but still
 *     require structure confirmation.
 *
 * Reuses every analysis the scanner already runs — only the THRESHOLDS and a
 * couple of new checks (NY session, opening-range exclusion, exhaustion)
 * differ.
 */

const MIN_CANDLE_STRENGTH       = 55;
const MIN_MARKET_STATE_SCORE    = 70;
const MIN_MTF_ALIGNMENT_SCORE   = 65;
const NAS100_MAX_OVEREXTENSION  = 40;     // stricter
const DEFAULT_MAX_OVEREXTENSION = 50;

const NY_SESSIONS = new Set([
  'NewYork', 'London/NewYork Overlap',
]);
const ACCEPTABLE_NON_NY_SESSIONS = new Set([
  'London',                              // overlapping morning trading
]);

const ALLOWED_STATES = new Set(['TRENDING', 'BREAKOUT']);

/**
 * Treat the first M15 candle of the NY session as the "opening range". For
 * simplicity, we approximate that as 30 minutes after the session changes to
 * NewYork or London/NewYork Overlap. Inside this window, demand explicit
 * confirmation (BOS / retest) before allowing an entry.
 *
 * This is a coarse proxy — there's no per-tick session marker on the M15
 * stream. It's good enough to disqualify the obvious cases.
 */
function isInsideOpeningRange(m15Candles) {
  if (!Array.isArray(m15Candles) || m15Candles.length < 4) return false;
  // Check if any of the last 2 bars saw a session boundary by looking at
  // their UTC hour and seeing if we crossed 13:30 UTC (NY equity open).
  const lastTwo = m15Candles.slice(-2);
  for (const c of lastTwo) {
    if (!c?.time) continue;
    const d = new Date(c.time * 1000 || c.time);
    const hours = d.getUTCHours();
    const mins = d.getUTCMinutes();
    if (hours === 13 && mins >= 30) return true;
    if (hours === 14 && mins < 30) return true;
  }
  return false;
}

/**
 * Prior session high/low — the last ~24h of H1 candles, excluding the last
 * 4 bars. Used to reject entries that fire directly into a recent extreme.
 */
function findPriorSessionExtremes(h1Candles) {
  if (!Array.isArray(h1Candles) || h1Candles.length < 30) return null;
  const window = h1Candles.slice(-30, -4);
  if (window.length < 12) return null;
  return {
    high: Math.max(...window.map(c => c.high)),
    low:  Math.min(...window.map(c => c.low)),
  };
}

/**
 * Composite score 0–100 for indices.
 *   +25  candleStrength ≥ 65        +12  ≥ 55
 *   +20  marketStateScore ≥ 80      +10  ≥ 70
 *   +20  mtfAlignment ≥ 75          +10  ≥ 65
 *   +15  NY session                  +5  London
 *   +10  pullback or retest signal in trade direction
 *   +10  marketState === BREAKOUT
 *   −20  overextension late-entry flag
 *   −25  exhaustion candle in trade direction
 *   −15  inside opening-range window without confirmation
 */
export function scoreIndexSetup({
  candleStrength, marketState, mtfAuthority, overextension,
  institutionalFlow, session, direction, inOpenRange,
}) {
  let s = 30;
  if (candleStrength?.candleStrengthScore >= 65) s += 25;
  else if (candleStrength?.candleStrengthScore >= 55) s += 12;

  if (marketState?.marketStateScore >= 80) s += 20;
  else if (marketState?.marketStateScore >= 70) s += 10;

  const align = mtfAuthority?.multiTimeframeAlignmentScore ?? 0;
  if (align >= 75) s += 20;
  else if (align >= 65) s += 10;

  if (NY_SESSIONS.has(session)) s += 15;
  else if (ACCEPTABLE_NON_NY_SESSIONS.has(session)) s += 5;

  const flows = institutionalFlow?.signals || [];
  const tradeSign = direction === 'long' ? 'bullish' : 'bearish';
  const pullbackOrRetest =
    overextension?.isPullbackEntry === true ||
    flows.some(f => (f.type === 'retest' || f.type === 'break_of_structure') && f.direction === tradeSign);
  if (pullbackOrRetest) s += 10;

  if (marketState?.marketState === 'BREAKOUT') s += 10;

  if (overextension?.lateEntryDetected) s -= 20;

  const exhaustionInDir = flows.some(
    f => f.type === 'exhaustion' && f.direction !== tradeSign
  );
  if (exhaustionInDir) s -= 25;

  if (inOpenRange && !pullbackOrRetest) s -= 15;

  return Math.max(0, Math.min(100, Math.round(s)));
}

export function buildIndexContext(args) { return { ...args }; }

export function qualifyIndexSignal(ctx) {
  const {
    pair, direction, h1Candles, m15Candles, currentPrice,
    candleStrength, marketState, mtfAuthority, overextension,
    institutionalFlow, lifecycle, session, pricing,
  } = ctx;

  const indexRejectionReasons = [];
  const isNas = String(pair).startsWith('NAS100');
  const maxOverextension = isNas ? NAS100_MAX_OVEREXTENSION : DEFAULT_MAX_OVEREXTENSION;
  const tradeSign = direction === 'long' ? 'bullish' : 'bearish';
  const flows = institutionalFlow?.signals || [];
  const inOpenRange = isInsideOpeningRange(m15Candles);

  // 1. Candle floor
  if ((candleStrength?.candleStrengthScore ?? 0) < MIN_CANDLE_STRENGTH) {
    indexRejectionReasons.push(
      `Rejected by indices logic: candle strength ${candleStrength?.candleStrengthScore ?? 0} ` +
      `< indices floor ${MIN_CANDLE_STRENGTH}. ${candleStrength?.reason ?? ''}`
    );
  }

  // 2. Market state must be TRENDING or BREAKOUT, score floor enforced
  if (!ALLOWED_STATES.has(marketState?.marketState)) {
    indexRejectionReasons.push(
      `Rejected by indices logic: market state ${marketState?.marketState} ` +
      `(indices allow only ${[...ALLOWED_STATES].join('/')})`
    );
  }
  if ((marketState?.marketStateScore ?? 0) < MIN_MARKET_STATE_SCORE) {
    indexRejectionReasons.push(
      `Rejected by indices logic: market state score ${marketState?.marketStateScore ?? 0} ` +
      `< indices floor ${MIN_MARKET_STATE_SCORE}`
    );
  }

  // 3. MTF alignment floor
  const align = mtfAuthority?.multiTimeframeAlignmentScore ?? 0;
  if (align < MIN_MTF_ALIGNMENT_SCORE) {
    indexRejectionReasons.push(
      `Rejected by indices logic: MTF alignment ${align}/100 < indices floor ${MIN_MTF_ALIGNMENT_SCORE}`
    );
  }

  // 4. Overextension (stricter for NAS100)
  if (overextension?.lateEntryDetected ||
      (overextension?.overextensionScore ?? 0) > maxOverextension) {
    indexRejectionReasons.push(
      `Rejected by indices logic: late ${pair} entry after extended impulse ` +
      `(overextension score ${overextension?.overextensionScore ?? 0}, ${pair.includes('NAS100') ? 'NAS100 cap' : 'index cap'} ${maxOverextension}). ` +
      `${overextension?.entryTimingReason ?? ''}`
    );
  }

  // 5. Exhaustion candle counter to trade direction
  const exhaustion = flows.find(f => f.type === 'exhaustion');
  if (exhaustion && exhaustion.direction !== tradeSign) {
    indexRejectionReasons.push(
      `Rejected by indices logic: exhaustion candle suggests reversal ` +
      `(${exhaustion.reason})`
    );
  }

  // 6. Continuation needs pullback / retest evidence
  const pullbackOrRetest =
    overextension?.isPullbackEntry === true ||
    flows.some(f => (f.type === 'retest' || f.type === 'break_of_structure') && f.direction === tradeSign);
  if (marketState?.marketState === 'TRENDING' && !pullbackOrRetest) {
    indexRejectionReasons.push(
      `Rejected by indices logic: continuation entry in TRENDING state requires retest / BOS confirmation`
    );
  }

  // 7. Session — NY preferred. London accepted with confidence hit, all else rejected.
  if (!NY_SESSIONS.has(session) && !ACCEPTABLE_NON_NY_SESSIONS.has(session)) {
    indexRejectionReasons.push(
      `Rejected by indices logic: ${session} session — indices are overnight chop outside NY/London`
    );
  }

  // 8. Opening range exclusion — require confirmation in the first NY half-hour
  if (inOpenRange && !pullbackOrRetest) {
    indexRejectionReasons.push(
      `Rejected by indices logic: inside NY opening range without retest / BOS confirmation`
    );
  }

  // 9. Prior session extreme proximity
  const priorExtremes = findPriorSessionExtremes(h1Candles);
  if (priorExtremes && Number.isFinite(currentPrice)) {
    // index pip = 1.0 for NAS100/US30 on OANDA
    const proximity = (marketState?.macroAtrPips || 60) * 0.4;
    if (direction === 'long' &&
        priorExtremes.high > currentPrice &&
        (priorExtremes.high - currentPrice) < proximity) {
      indexRejectionReasons.push(
        `Rejected by indices logic: long entry within 0.4×ATR of prior session high ${priorExtremes.high} — entering into resistance`
      );
    }
    if (direction === 'short' &&
        priorExtremes.low < currentPrice &&
        (currentPrice - priorExtremes.low) < proximity) {
      indexRejectionReasons.push(
        `Rejected by indices logic: short entry within 0.4×ATR of prior session low ${priorExtremes.low} — entering into support`
      );
    }
  }

  // 10. Spread/TP economics — index cap 8%
  const tpPips = lifecycle?.tp?.takeProfitPips;
  const spreadPips = pricing?.spreadPips;
  if (tpPips && spreadPips && (spreadPips / tpPips) > 0.08) {
    indexRejectionReasons.push(
      `Rejected by indices logic: spread ${spreadPips}p / TP ${tpPips}p = ` +
      `${((spreadPips / tpPips) * 100).toFixed(0)}% > indices cap 8%`
    );
  }

  const indexSetupScore = scoreIndexSetup({
    candleStrength, marketState, mtfAuthority, overextension,
    institutionalFlow, session, direction, inOpenRange,
  });

  const indexSessionReason = NY_SESSIONS.has(session)
    ? `Preferred ${pair} session: ${session}`
    : ACCEPTABLE_NON_NY_SESSIONS.has(session)
      ? `Acceptable ${pair} session: ${session}`
      : `Sub-optimal ${pair} session: ${session}`;

  const indexStructureReason =
    `${pullbackOrRetest ? 'Pullback/retest confirmed' : 'No pullback/retest signal'} · ` +
    `MTF ${align}/100 · state ${marketState?.marketState}`;

  const indexVolatilityReason =
    `Market state ${marketState?.marketState} (${marketState?.marketStateScore}/100), ` +
    `candle ${candleStrength?.classification} (${candleStrength?.candleStrengthScore}/100), ` +
    `overextension ${overextension?.overextensionScore ?? 0}/100`;

  return {
    selectedLogicType: 'indices',
    accepted: indexRejectionReasons.length === 0,
    indexSetupScore,
    indexSessionReason,
    indexStructureReason,
    indexVolatilityReason,
    indexRejectionReasons,
    priorSessionExtremes: priorExtremes,
    inOpenRange,
    thresholds: {
      MIN_CANDLE_STRENGTH,
      MIN_MARKET_STATE_SCORE,
      MIN_MTF_ALIGNMENT_SCORE,
      maxOverextension,
    },
  };
}
