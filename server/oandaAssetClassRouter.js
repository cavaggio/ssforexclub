/**
 * server/oandaAssetClassRouter.js
 *
 * Routes every signal through the correct asset-class qualifier:
 *
 *     Forex pairs              →  qualifyForexSignal
 *     XAU_USD / XAG_USD        →  qualifyMetalsSignal
 *     NAS100_USD / US30_USD …  →  qualifyIndexSignal
 *
 * Forex is no longer an unconditional pass-through. Explicit countertrend
 * consensus is a hard risk block so an active-window/perfect-alignment/V3
 * promotion cannot turn a locally bullish trigger into a long trade while the
 * authoritative structures remain bearish (or vice versa).
 */

import { qualifyMetalsSignal } from './oandaMetalsQualifier.js';
import { qualifyIndexSignal }  from './oandaIndicesQualifier.js';

function normalizeBias(value) {
  const v = String(value || '').trim().toLowerCase();
  if (['bull', 'bullish', 'buy', 'long', 'up', 'aligned_bullish'].includes(v)) return 'bullish';
  if (['bear', 'bearish', 'sell', 'short', 'down', 'aligned_bearish'].includes(v)) return 'bearish';
  return null;
}

function expectedBias(direction) {
  const d = String(direction || '').trim().toLowerCase();
  if (d === 'long' || d === 'buy' || d === 'bullish') return 'bullish';
  if (d === 'short' || d === 'sell' || d === 'bearish') return 'bearish';
  return null;
}

function opposingBias(direction) {
  const expected = expectedBias(direction);
  return expected === 'bullish' ? 'bearish' : expected === 'bearish' ? 'bullish' : null;
}

/**
 * Return a hard rejection only for explicit directional opposition.
 * Missing/mixed data does not reject, which avoids suppressing trades merely
 * because one market-data request degraded.
 */
export function evaluateForexDirectionalConsensus(ctx = {}) {
  const direction = ctx.direction;
  const expected = expectedBias(direction);
  const opposing = opposingBias(direction);

  if (!expected || !opposing) {
    return {
      accepted: false,
      reason: 'Directional risk cap: missing executable forex direction.',
      expected,
      opposing,
      biases: {},
    };
  }

  const biases = {
    daily: normalizeBias(ctx?.macro?.dailyTrend ?? ctx?.macro?.macroBias),
    h4: normalizeBias(
      ctx?.mtfAuthority?.higherTimeframeBias ??
      ctx?.macro?.h4Trend
    ),
    h1: normalizeBias(
      ctx?.mtfAuthority?.confirmationTimeframeBias ??
      ctx?.structure?.h1Trend
    ),
    m30: normalizeBias(ctx?.structure?.m30Trend),
    m15: normalizeBias(
      ctx?.mtfAuthority?.entryTimeframeBias ??
      ctx?.momentum?.m15Trend
    ),
    m5: normalizeBias(ctx?.momentum?.m5Trend),
  };

  const explicit = Object.entries(biases).filter(([, bias]) => bias != null);
  const aligned = explicit.filter(([, bias]) => bias === expected).map(([tf]) => tf);
  const opposed = explicit.filter(([, bias]) => bias === opposing).map(([tf]) => tf);

  // Existing structure authority defines this as direction opposing both H4/H1.
  const authorityConflict = ctx?.mtfAuthority?.conflict === true;
  const h4H1Oppose = biases.h4 === opposing && biases.h1 === opposing;

  // Daily + H4 + M15 are the primary execution timeframes in this repository.
  // Two explicit opposing primary structures with no aligned primary structure
  // are sufficient to block. This catches the photographed GBP/USD long while
  // still allowing a genuine, confirmed transition rather than a single M15 pop.
  const primary = ['daily', 'h4', 'm15'];
  const primaryOpposed = primary.filter((tf) => biases[tf] === opposing);
  const primaryAligned = primary.filter((tf) => biases[tf] === expected);
  const primaryConsensusOpposes = primaryOpposed.length >= 2 && primaryAligned.length === 0;

  // All available structural layers opposing is always a hard block.
  const allExplicitOppose = explicit.length >= 3 && opposed.length === explicit.length;

  const blocked = authorityConflict || h4H1Oppose || primaryConsensusOpposes || allExplicitOppose;
  if (blocked) {
    const reason =
      `Directional risk cap: ${direction} entry opposes market-structure consensus ` +
      `(expected ${expected}; opposed=${opposed.join(',') || 'none'}; ` +
      `aligned=${aligned.join(',') || 'none'}).`;

    return {
      accepted: false,
      reason,
      expected,
      opposing,
      biases,
      aligned,
      opposed,
      authorityConflict,
      h4H1Oppose,
      primaryConsensusOpposes,
      allExplicitOppose,
    };
  }

  return {
    accepted: true,
    reason: aligned.length
      ? `Forex direction has aligned structure on ${aligned.join(',')}.`
      : 'No explicit countertrend structure consensus detected.',
    expected,
    opposing,
    biases,
    aligned,
    opposed,
    authorityConflict,
    h4H1Oppose,
    primaryConsensusOpposes,
    allExplicitOppose,
  };
}

export function qualifyForexSignal(ctx = {}) {
  const consensus = evaluateForexDirectionalConsensus(ctx);
  return {
    selectedLogicType: 'forex',
    accepted: consensus.accepted,
    score: null,
    rejectionReasons: consensus.accepted ? [] : [consensus.reason],
    classSpecific: {
      note: consensus.accepted
        ? 'Forex passed waterfall, entry-quality, and directional-consensus gates.'
        : 'Forex blocked by the non-softenable directional risk cap.',
      directionalConsensus: consensus,
    },
  };
}

export function qualifyByAssetClass(ctx) {
  const assetClass = ctx?.profile?.assetClass || 'Forex';
  if (assetClass === 'Metal') {
    const r = qualifyMetalsSignal(ctx);
    return {
      selectedLogicType: 'metals',
      assetClass,
      accepted: r.accepted,
      score: r.metalsSetupScore,
      rejectionReasons: r.metalsRejectionReasons,
      classSpecific: r,
    };
  }
  if (assetClass === 'Index') {
    const r = qualifyIndexSignal(ctx);
    return {
      selectedLogicType: 'indices',
      assetClass,
      accepted: r.accepted,
      score: r.indexSetupScore,
      rejectionReasons: r.indexRejectionReasons,
      classSpecific: r,
    };
  }
  const r = qualifyForexSignal(ctx);
  return {
    selectedLogicType: r.selectedLogicType,
    assetClass,
    accepted: r.accepted,
    score: r.score,
    rejectionReasons: r.rejectionReasons,
    classSpecific: r.classSpecific,
  };
}
