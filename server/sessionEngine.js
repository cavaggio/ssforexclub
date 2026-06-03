/**
 * server/sessionEngine.js
 *
 * Signal Stack V3 — Session Analysis Layer (priority #3).
 *
 *   analyzeSession({ now, h1Candles, atrPips, atrHistorical })
 *
 * Institutional moves cluster around session opens and overlaps. This layer
 * scores the quality of the current time-of-day for taking a trade and gives a
 * coarse session bias from recent intraday flow.
 *
 * Output:
 *   {
 *     activeSession,        // 'London' | 'NewYork' | 'London/NewYork Overlap' | ...
 *     sessionVolatility,    // 'low' | 'normal' | 'high'
 *     sessionBias,          // 'bullish' | 'bearish' | 'neutral'
 *     sessionQualityScore,  // 0–100 (London/NY open + overlap highest)
 *     reasons: []
 *   }
 *
 * activeSession mirrors getForexSession()'s UTC ranges exactly, but accepts an
 * injectable `now` so the layer is deterministically testable.
 */

// Mirror of getForexSession() (oandaMarketData.js) — kept in sync intentionally.
export function sessionForHour(hour) {
  if (hour >= 12 && hour < 16) return 'London/NewYork Overlap';
  if (hour >= 7  && hour < 9)  return 'Tokyo/London Overlap';
  if (hour >= 0  && hour < 2)  return 'Sydney/Tokyo Overlap';
  if (hour >= 20 || hour < 0)  return 'Sydney';
  if (hour >= 0  && hour < 7)  return 'Tokyo';
  if (hour >= 7  && hour < 12) return 'London';
  if (hour >= 12 && hour < 20) return 'NewYork';
  return 'Closed';
}

// Quality tiers. The two overlaps coincide with the London open (Tokyo/London)
// and the New York open (London/NewYork) — the highest-quality windows.
const SESSION_QUALITY = {
  'London/NewYork Overlap': 95, // NY open + London afternoon — peak liquidity
  'Tokyo/London Overlap': 88,   // London open
  'London': 80,
  'NewYork': 76,
  'Sydney/Tokyo Overlap': 45,
  'Tokyo': 50,
  'Sydney': 35,
  'Closed': 10,
};

function sessionInferredVolatility(session) {
  if (session.includes('Overlap') && session !== 'Sydney/Tokyo Overlap') return 'high';
  if (session === 'London' || session === 'NewYork') return 'normal';
  return 'low';
}

export function analyzeSession({ now = null, h1Candles = [], atrPips = null, atrHistorical = null } = {}) {
  const reasons = [];
  const hour = (now instanceof Date ? now : now != null ? new Date(now) : new Date()).getUTCHours();
  const activeSession = sessionForHour(hour);

  const sessionQualityScore = SESSION_QUALITY[activeSession] ?? 40;
  reasons.push(`Active session: ${activeSession} (quality ${sessionQualityScore}/100).`);

  // Volatility — prefer the measured ATR ratio, fall back to a session prior.
  let sessionVolatility;
  if (Number.isFinite(atrPips) && Number.isFinite(atrHistorical) && atrHistorical > 0) {
    const ratio = atrPips / atrHistorical;
    if (ratio >= 1.3) sessionVolatility = 'high';
    else if (ratio <= 0.7) sessionVolatility = 'low';
    else sessionVolatility = 'normal';
    reasons.push(`ATR ${atrPips}p vs historical ${atrHistorical}p (${(ratio * 100).toFixed(0)}%) → ${sessionVolatility} volatility.`);
  } else {
    sessionVolatility = sessionInferredVolatility(activeSession);
    reasons.push(`Volatility inferred from session → ${sessionVolatility}.`);
  }

  // Bias — net direction of the most recent intraday candles.
  let sessionBias = 'neutral';
  if (Array.isArray(h1Candles) && h1Candles.length >= 4) {
    const recent = h1Candles.slice(-6);
    const net = recent[recent.length - 1].close - recent[0].open;
    const span = Math.max(...recent.map((c) => c.high)) - Math.min(...recent.map((c) => c.low));
    if (span > 0 && Math.abs(net) / span >= 0.4) {
      sessionBias = net > 0 ? 'bullish' : 'bearish';
      reasons.push(`Intraday flow ${sessionBias} (net ${net > 0 ? '+' : ''}${net.toFixed(5)} over last ${recent.length} bars).`);
    } else {
      reasons.push('Intraday flow indecisive — neutral session bias.');
    }
  }

  return { activeSession, sessionVolatility, sessionBias, sessionQualityScore, reasons };
}

// ─── Session narrative (V3.5) ────────────────────────────────────────────────
/**
 * Turn the raw session + liquidity sweep + structure into an ICT-style trade
 * story: "London swept Asian Low", "New York continuation", "London breakout",
 * "Asian accumulation", etc. PURE and read-only — kept OUT of analyzeSession so
 * that layer's signature/tests are unaffected.
 *
 *   buildSessionNarrative({ session, liquidity, structure })
 *     session   — output of analyzeSession()
 *     liquidity — output of analyzeLiquidity() (uses the labelled sweep)
 *     structure — output of analyzeMarketStructure() (BOS / CHoCH)
 *
 *   → { sessionNarrative, sessionBias, sessionConfidence }
 */
export function buildSessionNarrative({ session = null, liquidity = null, structure = null } = {}) {
  const sess = session?.activeSession || 'Closed';
  const sweep = liquidity?.liquiditySweep || null;
  const sweptSrc = sweep?.sweptSource || null;
  const sweepDir = sweep?.direction || null;            // 'bullish' | 'bearish'
  const inLondon = sess.includes('London');
  const inNY = sess.includes('NewYork');
  const inAsian = sess === 'Tokyo' || sess === 'Sydney' || sess.includes('Sydney/Tokyo');

  const choch = structure?.chochDetected ? structure.choch?.direction : null;
  const bos = structure?.bosDetected ? structure.bos?.direction : null;
  const sweeper = inLondon ? 'London' : inNY ? 'New York' : sess;

  let sessionNarrative;
  if (sweep && (sweptSrc === 'ASIA_L' || sweptSrc === 'ASIA_H')) {
    const which = sweptSrc === 'ASIA_L' ? 'Asian Low' : 'Asian High';
    sessionNarrative = `${sweeper} swept ${which}`;
    const reversal = (sweptSrc === 'ASIA_L' && choch === 'bullish') ||
                     (sweptSrc === 'ASIA_H' && choch === 'bearish');
    if (reversal) sessionNarrative += ` — reversal (CHoCH ${choch})`;
  } else if (sweep && (sweptSrc === 'EQH' || sweptSrc === 'EQL')) {
    sessionNarrative = `${sweep.sweptLiquidity} swept — stop run`;
    if (choch) sessionNarrative += `, CHoCH ${choch}`;
  } else if (sweep && sweptSrc) {
    sessionNarrative = `Swept ${sweep.sweptLiquidity}`;
    if (choch) sessionNarrative += ` — ${sweeper} reversal (CHoCH)`;
  } else if (inNY && bos && bos === structure?.structureTrend) {
    sessionNarrative = 'New York continuation';
  } else if (inLondon && choch) {
    sessionNarrative = 'London reversal (CHoCH)';
  } else if (inLondon && bos) {
    sessionNarrative = 'London breakout';
  } else if (inAsian && session?.sessionVolatility === 'low') {
    sessionNarrative = 'Asian accumulation / range';
  } else {
    const bias = session?.sessionBias && session.sessionBias !== 'neutral' ? `${session.sessionBias} bias` : 'no clear bias';
    sessionNarrative = `${sess} — ${bias}`;
  }

  // A clear sweep direction overrides a vague intraday-flow bias.
  let sessionBias = session?.sessionBias || 'neutral';
  if (sweepDir) sessionBias = sweepDir === 'bullish' ? 'bullish' : 'bearish';

  // Confidence: session quality, lifted when a named sweep corroborates structure.
  let conf = (session?.sessionQualityScore ?? 40) / 100;
  if (sweptSrc) conf += 0.1;
  const structDir = choch || bos;
  if (sweepDir && structDir && (sweepDir === 'bullish') === (structDir === 'bullish')) conf += 0.15;
  const sessionConfidence = +Math.max(0, Math.min(1, conf)).toFixed(3);

  return { sessionNarrative, sessionBias, sessionConfidence };
}

export { SESSION_QUALITY };
