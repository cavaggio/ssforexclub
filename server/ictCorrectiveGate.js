/**
 * Non-bypassable ICT corrective authorization gate.
 *
 * Continuation:
 *   D1/H4 aligned + H1 active momentum/transition aligned + fresh M5 trigger.
 * Reversal:
 *   HTF level tap + liquidity sweep + opposing displacement + CISD/MSS + fresh M5 trigger.
 * Anything else is rejected with stable failure codes that can be learned from.
 */

const finite = (value, fallback = null) => {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const asDate = (value) => {
  if (value instanceof Date) return value;
  const parsed = new Date(value ?? Date.now());
  return Number.isFinite(parsed.getTime()) ? parsed : new Date();
};

export const ICT_CORRECTIVE_FAILURES = Object.freeze({
  HTF_DIRECTION_NOT_ALIGNED: 'HTF_DIRECTION_NOT_ALIGNED',
  H1_ACTIVE_MOMENTUM_MISSING: 'H1_ACTIVE_MOMENTUM_MISSING',
  H1_MOMENTUM_EXHAUSTED: 'H1_MOMENTUM_EXHAUSTED',
  HTF_LEVEL_TAP_MISSING: 'HTF_LEVEL_TAP_MISSING',
  LIQUIDITY_SWEEP_MISSING: 'LIQUIDITY_SWEEP_MISSING',
  OPPOSING_DISPLACEMENT_MISSING: 'OPPOSING_DISPLACEMENT_MISSING',
  CISD_OR_MSS_MISSING: 'CISD_OR_MSS_MISSING',
  M5_TRIGGER_MISSING: 'M5_TRIGGER_MISSING',
  M5_TRIGGER_STALE: 'M5_TRIGGER_STALE',
  SETUP_CLASS_UNSUPPORTED: 'SETUP_CLASS_UNSUPPORTED',
});

const failure = (code, message, details = null) => ({ code, message, ...(details ? { details } : {}) });

export function buildIctM5Authorization({
  triggerType = null,
  triggerTime = null,
  now = new Date(),
  maxTriggerAgeMinutes = finite(process.env.ICT_M5_TRIGGER_MAX_AGE_MINUTES, 10),
  source = null,
} = {}) {
  const current = asDate(now);
  const parsedTrigger = Date.parse(triggerTime || '');
  const maxAge = Math.max(1, finite(maxTriggerAgeMinutes, 10));
  const triggerAgeMinutes = Number.isFinite(parsedTrigger)
    ? Math.max(0, (current.getTime() - parsedTrigger) / 60_000)
    : null;
  const present = Boolean(triggerType && Number.isFinite(parsedTrigger));
  const fresh = present && Number.isFinite(triggerAgeMinutes) && triggerAgeMinutes <= maxAge;
  return {
    triggerType: triggerType || null,
    triggerTime: Number.isFinite(parsedTrigger) ? new Date(parsedTrigger).toISOString() : null,
    triggerAgeMinutes: Number.isFinite(triggerAgeMinutes) ? +triggerAgeMinutes.toFixed(2) : null,
    maxTriggerAgeMinutes: maxAge,
    fresh,
    source: source || null,
    ageBasis: 'event_timestamp',
  };
}

export function evaluateIctCorrectiveGate({
  setupClass,
  d1H4Aligned = false,
  h1ActiveMomentumAligned = false,
  h1TransitionAligned = false,
  h1MomentumExhausted = false,
  htfLevelTapped = false,
  liquiditySweep = false,
  opposingDisplacement = false,
  cisdOrMss = false,
  m5Authorization = null,
  evidence = null,
} = {}) {
  const normalized = String(setupClass || '').trim().toLowerCase();
  const failureReasons = [];
  const m5Present = Boolean(m5Authorization?.triggerType && m5Authorization?.triggerTime);
  const m5Fresh = m5Authorization?.fresh === true;

  if (normalized === 'continuation') {
    if (!d1H4Aligned) failureReasons.push(failure(
      ICT_CORRECTIVE_FAILURES.HTF_DIRECTION_NOT_ALIGNED,
      'Continuation rejected because D1 and H4 are not directionally aligned.',
    ));
    if (h1MomentumExhausted) failureReasons.push(failure(
      ICT_CORRECTIVE_FAILURES.H1_MOMENTUM_EXHAUSTED,
      'Continuation rejected because the active H1 move is already extended/exhausted.',
    ));
    if (!h1ActiveMomentumAligned && !h1TransitionAligned) failureReasons.push(failure(
      ICT_CORRECTIVE_FAILURES.H1_ACTIVE_MOMENTUM_MISSING,
      'Continuation rejected because H1 active momentum/transition is not aligned with D1/H4.',
    ));
  } else if (normalized === 'reversal') {
    if (!htfLevelTapped) failureReasons.push(failure(
      ICT_CORRECTIVE_FAILURES.HTF_LEVEL_TAP_MISSING,
      'Reversal rejected because no aligned higher-timeframe level was tapped.',
    ));
    if (!liquiditySweep) failureReasons.push(failure(
      ICT_CORRECTIVE_FAILURES.LIQUIDITY_SWEEP_MISSING,
      'Reversal rejected because the required liquidity sweep/manipulation was not confirmed.',
    ));
    if (!opposingDisplacement) failureReasons.push(failure(
      ICT_CORRECTIVE_FAILURES.OPPOSING_DISPLACEMENT_MISSING,
      'Reversal rejected because displacement opposing the liquidity-taking leg was not confirmed.',
    ));
    if (!cisdOrMss) failureReasons.push(failure(
      ICT_CORRECTIVE_FAILURES.CISD_OR_MSS_MISSING,
      'Reversal rejected because neither aligned CISD nor MSS is confirmed after displacement.',
    ));
  } else {
    failureReasons.push(failure(
      ICT_CORRECTIVE_FAILURES.SETUP_CLASS_UNSUPPORTED,
      `ICT corrective gate does not authorize setup class ${setupClass || 'unknown'}.`,
    ));
  }

  if (!m5Present) {
    failureReasons.push(failure(
      ICT_CORRECTIVE_FAILURES.M5_TRIGGER_MISSING,
      'Entry rejected because an exact M5 authorization event/timestamp is missing.',
    ));
  } else if (!m5Fresh) {
    failureReasons.push(failure(
      ICT_CORRECTIVE_FAILURES.M5_TRIGGER_STALE,
      `Entry rejected because the M5 trigger is ${m5Authorization?.triggerAgeMinutes ?? 'unknown'} minutes old; maximum age is ${m5Authorization?.maxTriggerAgeMinutes ?? 'unknown'} minutes.`,
    ));
  }

  return {
    ready: failureReasons.length === 0,
    setupClass: normalized || null,
    failureReasons,
    m5Authorization: m5Authorization || null,
    evidence: evidence || null,
  };
}
