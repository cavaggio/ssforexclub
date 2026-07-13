export const V3_LEGACY_MIN_PRIMARY_ALIGNMENT_SCORE = 67;

export function getLegacyPrimaryAlignmentScore(item = {}) {
  const score = Number(
    item?.alignment?.timeframeAlignmentScore ??
    item?.primaryTimeframeAlignment?.score ??
    item?.primaryTimeframeAlignment?.alignmentScore ??
    item?.score
  );
  return Number.isFinite(score) ? score : null;
}

/**
 * V3 may review only candidates already accepted by the legacy scanner.
 * scan.rejected is intentionally never read, ranked, watched, or promoted.
 */
export function selectV3ReviewCandidates(scan = {}, log = () => {}) {
  const qualified = Array.isArray(scan?.qualified) ? scan.qualified : [];
  const eligible = [];

  for (const item of qualified) {
    const score = getLegacyPrimaryAlignmentScore(item);
    if (score === null || score < V3_LEGACY_MIN_PRIMARY_ALIGNMENT_SCORE) {
      log(
        `legacy-boundary reject pair=${item?.pair || 'unknown'} ` +
        `primaryAlignment=${score ?? 'missing'} < ${V3_LEGACY_MIN_PRIMARY_ALIGNMENT_SCORE}`
      );
      continue;
    }
    eligible.push(item);
  }

  return eligible;
}
