/**
 * Score-only primary-timeframe policy wrapper.
 *
 * The legacy analysis module still computes every layer and the Daily/H4/M15
 * score. This wrapper removes only the redundant "any primary conflict" hard
 * rejection. The 67/100 aggregate score remains the hard gate.
 */

import {
  analyzeMacro,
  analyzeStructure,
  analyzeMomentum,
  computeAlignment as computeLegacyAlignment,
  computeConfidenceScore,
} from './oandaMtfAnalysisLegacy.js';

export { analyzeMacro, analyzeStructure, analyzeMomentum, computeConfidenceScore };

export function computeAlignment(args = {}) {
  const result = computeLegacyAlignment(args);
  const rejectionReasons = (result?.rejectionReasons || []).filter(
    (reason) => !/^Primary timeframe conflict:/i.test(String(reason || ''))
  );

  return {
    ...result,
    rejectionReasons,
    tradeQualified: rejectionReasons.length === 0,
    primaryConflictPolicy: 'diagnostic_only',
    minimums: {
      ...(result?.minimums || {}),
      minAlignmentScore: Math.max(67, Number(result?.minimums?.minAlignmentScore || 0)),
    },
  };
}
