function status(value) {
  return String(value || '').trim().toLowerCase();
}

/**
 * Classify an alignment-passed, geometrically valid V3 candidate without
 * changing any execution gate.
 *
 * - hot: only the entry trigger/retest is pending; recheck every 30 seconds.
 * - near: setup is worth retaining but not yet trigger-near; recheck every 60s.
 * - ready: all setup, trigger, and timing gates pass.
 * - none: rejected; do not watch.
 */
export function classifyV3WatchTier({
  primaryAlignment,
  geometryValid = true,
  newsBlocked = false,
  spreadOk = true,
  entryTiming,
  stage1,
  stage2,
} = {}) {
  if (primaryAlignment?.passed !== true || geometryValid !== true || newsBlocked || !spreadOk) {
    return { tier: 'none', reason: 'hard pre-watch gate failed' };
  }

  const timing = status(entryTiming?.status);
  if (timing === 'news_blocked' || timing === 'late_entry') {
    return { tier: 'none', reason: `entry timing ${timing}` };
  }

  // A confirmed breakout that is waiting specifically for its retest is the
  // definition of Hot Watch. It may still be below the execution confidence
  // threshold; monitoring does not waive that threshold.
  if (timing === 'wait_for_retest') {
    return { tier: 'hot', reason: 'waiting for confirmed retest' };
  }

  // Too early is a valid setup-development state, but not trigger-near yet.
  if (timing === 'too_early') {
    return { tier: 'near', reason: 'waiting for price to enter the setup zone' };
  }

  if (stage1?.allowed === true && stage2?.allowed === true && timing === 'valid_entry') {
    return { tier: 'ready', reason: 'setup, trigger, and entry timing passed' };
  }

  // Stage 2 watch means the setup passed and only a fresh sweep/BOS/CHoCH or
  // compression-expansion trigger is missing. That belongs on the 30s watch.
  if (stage1?.allowed === true && stage2?.state === 'watch') {
    return { tier: 'hot', reason: 'waiting for fresh primary trigger' };
  }

  if (stage1?.allowed === true && stage2?.allowed !== true) {
    return { tier: 'near', reason: 'setup passed but trigger support is incomplete' };
  }

  return { tier: 'none', reason: 'setup quality gate did not pass' };
}
