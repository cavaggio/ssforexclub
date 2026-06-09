/**
 * server/v3IctComparison.js
 *
 * DISPLAY-ONLY V3-vs-ICT comparison for the dashboard. This is the ONLY place
 * the ICT side touches V3. It is computed AFTER ICT analysis, never feeds back
 * into ICT qualification/execution, and is fully fail-safe: if it throws, the
 * per-pair comparison is null and ICT analysis is unaffected.
 *
 *   computeV3Comparisons(analyses, { client }) → { [pair]: comparison | null }
 */

import { getCandles } from './oandaMarketData.js';
import { evaluateV3 } from './v3Engine.js';

const NOTE = 'Display only — not used for ICT qualification or execution';

export async function computeV3Comparisons(analyses, { client } = {}) {
  const out = {};
  for (const a of analyses || []) {
    if (!a?.pair) continue;
    try {
      const [daily, h4, h1, m15] = await Promise.all([
        getCandles(a.pair, 'D', 60, { client }).catch(() => []),
        getCandles(a.pair, 'H4', 60, { client }).catch(() => []),
        getCandles(a.pair, 'H1', 120, { client }).catch(() => []),
        getCandles(a.pair, 'M15', 120, { client }).catch(() => []),
      ]);
      const price = m15.length ? m15[m15.length - 1].close : null;
      const v3 = evaluateV3({
        pair: a.pair, legacyDirection: null,
        dailyCandles: daily, h4Candles: h4, h1Candles: h1, m15Candles: m15,
        currentPrice: price, atrPips: null, momentum: null,
      });
      const ictDir = a.signal === 'buy' ? 'long' : a.signal === 'sell' ? 'short' : null;
      out[a.pair] = {
        v3Direction: v3.direction,
        v3Score: v3.score,
        v3Qualified: v3.qualified,
        ictDirection: ictDir,
        agrees: ictDir != null && v3.direction != null && ictDir === v3.direction,
        note: NOTE,
      };
    } catch {
      out[a.pair] = null; // comparison is best-effort; ICT analysis still stands
    }
  }
  return out;
}
