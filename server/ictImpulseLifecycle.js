const text = (value) => String(value ?? '').trim();

const normalizePair = (value) => text(value).replace('/', '_').toUpperCase();

const normalizeDirection = (value) => {
  const direction = text(value).toLowerCase();
  if (['long', 'buy', 'bullish'].includes(direction)) return 'long';
  if (['short', 'sell', 'bearish'].includes(direction)) return 'short';
  return null;
};

const entryFamily = (analysis = {}) => {
  const explicit = text(analysis?.correctiveGate?.family).toLowerCase();
  if (explicit === 'continuation' || explicit === 'reversal') return explicit;
  const mode = text(analysis?.entryAuthorization?.mode).toLowerCase();
  if (mode === 'h1_transition' || mode.startsWith('m5_continuation_')) return 'continuation';
  if (mode.startsWith('initial_reversal_')) return 'reversal';
  return null;
};

export const ICT_IMPULSE_LIFECYCLE_FAILURE = 'IMPULSE_ALREADY_CONSUMED';

/**
 * Build an additive lifecycle identity for autonomous ICT continuation entries.
 *
 * Directional thesis and entry freshness are intentionally separate:
 * - D1/H4/H1/M5 continue to decide whether the thesis/setup is valid.
 * - This identity decides whether the same H1 impulse has already been traded.
 *
 * Reversal/manual logic is not altered by this helper. If a stable H1 anchor is
 * unavailable, callers fall back to the existing entry-cycle reservation rather
 * than inventing a new hard gate.
 */
export function buildIctImpulseLifecycle({
  analysis = {},
  accountId = null,
  pair = null,
  direction = null,
} = {}) {
  const family = entryFamily(analysis);
  const normalizedPair = normalizePair(pair || analysis?.pair);
  const normalizedDirection = normalizeDirection(
    direction || analysis?.direction || analysis?.ictBias || analysis?.signal,
  );
  const authorization = analysis?.entryAuthorization || {};
  const momentum = analysis?.h1Momentum || {};
  const transition = analysis?.h1Transition || {};
  const earlySession = analysis?.earlySessionDirection || {};

  if (family !== 'continuation') {
    return {
      applies: false,
      family,
      pair: normalizedPair || null,
      direction: normalizedDirection,
      reason: 'Impulse lifecycle is additive to autonomous ICT continuation entries only.',
    };
  }

  let anchorId = text(momentum?.impulseId);
  let anchorSource = anchorId ? 'h1_active_impulse' : null;

  if (!anchorId) {
    anchorId = text(transition?.transitionId);
    if (anchorId) anchorSource = 'h1_transition';
  }

  if (!anchorId && earlySession?.alignedWithBias === true && text(earlySession?.dateKey)) {
    anchorId = `${normalizedDirection || 'unknown'}:early-session:${text(earlySession.dateKey)}`;
    anchorSource = 'early_session_narrative';
  }

  if (!normalizedPair || !normalizedDirection || !anchorId) {
    return {
      applies: false,
      family,
      pair: normalizedPair || null,
      direction: normalizedDirection,
      reason: 'No stable H1 impulse anchor is available; preserve the existing entry-cycle guard.',
    };
  }

  const lifecycleId = [normalizedPair, normalizedDirection, anchorId].join('|');
  const fingerprint = [
    'ict-h1-impulse',
    text(accountId) || 'default',
    normalizedPair,
    normalizedDirection,
    anchorId,
  ].join('|');

  return {
    applies: true,
    family,
    id: lifecycleId,
    fingerprint,
    pair: normalizedPair,
    direction: normalizedDirection,
    anchorId,
    anchorSource,
    m5CycleId: text(authorization?.cycleId) || null,
    directionalThesisValid: analysis?.correctiveGate?.passed === true,
    entryFresh: true,
    state: 'fresh',
    failureCode: ICT_IMPULSE_LIFECYCLE_FAILURE,
  };
}
