/**
 * server/v3ShadowLog.js
 *
 * Signal Stack V3 — shadow-mode comparison logging + reporting.
 *
 * In shadow mode the scanner evaluates BOTH the legacy waterfall and the V3
 * model on every data-sufficient pair, WITHOUT changing any live decision, and
 * records the divergence here. Over time this accrues the real comparison data
 * needed to judge the V3 model before it is switched to 'active'.
 *
 *   recordV3Shadow({ qualified, rejected, v3ByPair, session, nowIso })
 *   getShadowRows()
 *   generateV3ComparisonReport(rows?)
 *
 * Persistence is best-effort to FOREX_V3_SHADOW_LOG_PATH (default
 * server/data/v3-shadow-log.json), capped to the most recent MAX_ROWS. A
 * failure to read/write the file degrades to in-memory only and never throws
 * into the scan loop.
 */

import { readFileSync, writeFile } from 'node:fs';
import { resolve } from 'node:path';

const LOG_PATH = process.env.FOREX_V3_SHADOW_LOG_PATH
  || resolve(process.cwd(), 'server', 'data', 'v3-shadow-log.json');
const MAX_ROWS = parseInt(process.env.FOREX_V3_SHADOW_MAX_ROWS || '2000', 10);

let _rows = null; // lazy-loaded ring buffer

function load() {
  if (_rows !== null) return _rows;
  try {
    const txt = readFileSync(LOG_PATH, 'utf8');
    const parsed = JSON.parse(txt);
    _rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.rows) ? parsed.rows : [];
  } catch {
    _rows = [];
  }
  return _rows;
}

function persist() {
  // Best-effort async write; never blocks or throws into the caller.
  try {
    writeFile(LOG_PATH, JSON.stringify(_rows.slice(-MAX_ROWS)), (err) => {
      if (err) console.log(`[V3_SHADOW] persist skipped: ${err.message}`);
    });
  } catch (err) {
    console.log(`[V3_SHADOW] persist skipped: ${err.message}`);
  }
}

function agreementOf(legacyQ, v3Q) {
  if (legacyQ && v3Q) return 'both';
  if (legacyQ && !v3Q) return 'legacy_only';
  if (!legacyQ && v3Q) return 'v3_only';
  return 'neither';
}

/**
 * Build comparison rows and append them to the shadow log. Returns the rows
 * created this scan (also useful for inline logging/tests).
 */
export function recordV3Shadow({ qualified = [], rejected = [], v3ByPair = {}, session = null, nowIso = null }) {
  const rows = load();
  const qualifiedByPair = new Map();
  for (const s of qualified) qualifiedByPair.set(s.pair, s);
  const rejectedSet = new Set((rejected || []).map((r) => r.pair));

  const created = [];
  for (const [pair, v3] of Object.entries(v3ByPair)) {
    if (!v3) continue;
    const legacySig = qualifiedByPair.get(pair) || null;
    const legacyQualified = qualifiedByPair.has(pair);
    // A pair is "legacy rejected" if it isn't qualified (it may be in rejected[]
    // or simply absent; either way it's not a legacy signal).
    const row = {
      ts: nowIso,
      pair,
      session,
      legacy: {
        qualified: legacyQualified,
        direction: legacySig?.direction ?? null,
        score: legacySig?.score ?? null,
        confidence: legacySig?.confidence ?? null,
        inRejected: rejectedSet.has(pair),
      },
      v3: {
        qualified: v3.qualified,
        direction: v3.direction,
        score: v3.score,
        earlyTrigger: v3.earlyTrigger,
        entryDistancePct: v3.entryDistanceFromOriginPct,
        volatilityState: v3.volatility?.volatilityState ?? null,
        liquiditySweep: v3.liquidity?.liquiditySweepDetected ?? false,
        structureTrend: v3.structure?.structureTrend ?? null,
        topRejection: v3.rejectionReasons?.[0] ?? null,
      },
      agreement: agreementOf(legacyQualified, v3.qualified),
      directionAgrees: v3.directionAgrees,
    };
    created.push(row);
    _rows.push(row);
  }

  if (_rows.length > MAX_ROWS) _rows = _rows.slice(-MAX_ROWS);
  if (created.length) {
    persist();
    const counts = created.reduce((acc, r) => { acc[r.agreement] = (acc[r.agreement] || 0) + 1; return acc; }, {});
    console.log(
      `[V3_SHADOW] ${created.length} pairs compared — ` +
      `both=${counts.both || 0} legacyOnly=${counts.legacy_only || 0} ` +
      `v3Only=${counts.v3_only || 0} neither=${counts.neither || 0}`,
    );
  }
  return created;
}

export function getShadowRows() { return load().slice(); }

function avg(nums) {
  const xs = nums.filter((n) => Number.isFinite(n));
  return xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3) : null;
}

/**
 * Aggregate the shadow rows into a comparison report. The timing KPI is the
 * average entry-distance-from-move-origin: a LOWER value for V3-qualified than
 * for legacy-qualified means V3 enters earlier in the move.
 *
 * Win-rate / RR / expectancy require resolved trades, of which there are none
 * yet; those fields are present but null with an explicit note, per the
 * shadow-first validation plan.
 */
export function generateV3ComparisonReport(rows = null) {
  const data = rows || load();
  const n = data.length;
  const legacyQ = data.filter((r) => r.legacy.qualified);
  const v3Q = data.filter((r) => r.v3.qualified);

  const agreement = data.reduce((acc, r) => { acc[r.agreement] = (acc[r.agreement] || 0) + 1; return acc; }, { both: 0, legacy_only: 0, v3_only: 0, neither: 0 });
  const both = data.filter((r) => r.agreement === 'both');
  const directionAgreeRate = both.length
    ? +(both.filter((r) => r.directionAgrees).length / both.length).toFixed(3)
    : null;

  const avgEntryDistanceLegacy = avg(legacyQ.map((r) => r.v3.entryDistancePct)); // legacy-qualified pairs, measured on same metric
  const avgEntryDistanceV3 = avg(v3Q.map((r) => r.v3.entryDistancePct));
  const earlierBy =
    avgEntryDistanceLegacy != null && avgEntryDistanceV3 != null
      ? +(avgEntryDistanceLegacy - avgEntryDistanceV3).toFixed(3)
      : null;

  return {
    generatedFrom: n,
    counts: {
      evaluated: n,
      legacyQualified: legacyQ.length,
      v3Qualified: v3Q.length,
    },
    agreement,
    directionAgreeRate,
    timing: {
      // Primary KPI — lower entry distance from origin = earlier entries.
      avgEntryDistanceFromOrigin_legacyQualified: avgEntryDistanceLegacy,
      avgEntryDistanceFromOrigin_v3Qualified: avgEntryDistanceV3,
      v3EntersEarlierByPctOfImpulse: earlierBy,
      earlyTriggerRate_v3Qualified: v3Q.length
        ? +(v3Q.filter((r) => r.v3.earlyTrigger).length / v3Q.length).toFixed(3)
        : null,
    },
    scores: {
      avgScore_legacyQualified: avg(legacyQ.map((r) => r.legacy.score)),
      avgScore_v3Qualified: avg(v3Q.map((r) => r.v3.score)),
    },
    expectancy: {
      note: 'Win-rate / average-RR / expectancy require resolved trades. None are recorded yet; these will populate from accrued live outcomes once trades close.',
      winRate_legacy: null,
      winRate_v3: null,
      avgRR_legacy: null,
      avgRR_v3: null,
    },
    verdict:
      earlierBy == null
        ? 'Insufficient data — keep accruing shadow comparisons.'
        : earlierBy > 0
          ? `V3 enters ~${(earlierBy * 100).toFixed(1)}% of the impulse earlier than legacy on qualified setups (timing improved). Expectancy verdict pending resolved trades.`
          : `V3 does not yet show earlier entries (${(earlierBy * 100).toFixed(1)}%). Do not promote to active.`,
  };
}

export { LOG_PATH, MAX_ROWS };
