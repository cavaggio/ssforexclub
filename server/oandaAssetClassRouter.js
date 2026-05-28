/**
 * server/oandaAssetClassRouter.js
 *
 * Routes every signal through the correct asset-class qualifier:
 *
 *     Forex pairs              →  qualifyForexSignal (pass-through)
 *     XAU_USD / XAG_USD        →  qualifyMetalsSignal
 *     NAS100_USD / US30_USD …  →  qualifyIndexSignal
 *
 * The router does NOT re-implement candle/state/MTF analysis — it reuses
 * everything the scanner has already computed. Its only job is to:
 *
 *   1. Pick the right qualifier based on `profile.assetClass`
 *   2. Fold its decision into the existing rejection-reasons pipeline
 *   3. Emit `selectedLogicType` and asset-class-specific debug fields so the
 *      dashboard knows which path made the call
 *
 *   qualifyByAssetClass(ctx)  →  {
 *     selectedLogicType:        'forex' | 'metals' | 'indices',
 *     assetClass,
 *     accepted,
 *     score,                                — class-specific scalar
 *     rejectionReasons,
 *     classSpecific:                        — full qualifier output
 *   }
 */

import { qualifyMetalsSignal } from './oandaMetalsQualifier.js';
import { qualifyIndexSignal }  from './oandaIndicesQualifier.js';

/**
 * Forex qualifier — pass-through. The existing waterfall + entry-quality
 * layer + extended qualification gates already handle forex thoroughly. We
 * keep this as an explicit function so the router has a single dispatch
 * shape and so a future "forex profile tightening" can land in one place.
 */
export function qualifyForexSignal(_ctx) {
  return {
    selectedLogicType: 'forex',
    accepted: true,
    score: null,
    rejectionReasons: [],
    classSpecific: { note: 'Forex uses the existing waterfall + entry-quality gates.' },
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
