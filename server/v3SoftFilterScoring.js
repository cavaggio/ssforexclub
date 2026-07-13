export function applyJune23SoftFilterScoring(candidate = {}) {
  let confidenceAdjustment = 0;
  const softReasons = [];
  const adjust = (condition, yes, no, yesText, noText) => {
    if (condition === true) { confidenceAdjustment += yes; softReasons.push(yesText); }
    else if (condition === false && no) { confidenceAdjustment += no; softReasons.push(noText); }
  };
  adjust(candidate.regimeAligned, 1, -1, 'Regime aligned: +1 confidence', 'Regime not aligned: -1 confidence');
  adjust(candidate.liquidityIntentStrong, 2, -1, 'Strong liquidity intent: +2 confidence', 'Weak liquidity intent: -1 confidence');
  adjust(candidate.calibrationPositive, 1, -1, 'Positive calibration: +1 confidence', 'Negative calibration: -1 confidence');
  if (candidate.smtDivergence === true) { confidenceAdjustment += 1; softReasons.push('SMT divergence present: +1 confidence'); }
  if (candidate.sessionNarrativeAligned === true) { confidenceAdjustment += 1; softReasons.push('Session narrative aligned: +1 confidence'); }
  const baseConfidence = Number(candidate.confidence ?? 0);
  return { ...candidate, baseConfidence,
    confidence: Math.max(0, Math.min(100, baseConfidence + confidenceAdjustment)),
    confidenceAdjustment, softReasons };
}
