
// Retrace Watch Mode
// Keeps high-confidence pairs under active watch until retracement enters entry zone.
// This prevents the bot from scanning once, saying TOO_EARLY, then missing the trade.

const watched = new Map();

const MIN_CONFIDENCE = Number(process.env.RETRACE_WATCH_MIN_CONFIDENCE || 80);
const MIN_RR = Number(process.env.RETRACE_WATCH_MIN_RR || 1.5);
const TTL_MS = Number(process.env.RETRACE_WATCH_TTL_MS || 45 * 60 * 1000);
const MAX_WATCHED = Number(process.env.RETRACE_WATCH_MAX_PAIRS || 8);

function now() {
  return Date.now();
}

function pairKey(signal = {}) {
  return signal.pair || signal.instrument || signal.symbol || signal.name;
}

function confidenceOf(signal = {}) {
  return Number(
    signal.confidence ??
    signal.conf ??
    signal.score ??
    signal.alignmentScore ??
    signal.alignScore ??
    0
  );
}

function rrOf(signal = {}) {
  return Number(
    signal.rr ??
    signal.riskReward ??
    signal.expectedRR ??
    signal.rewardRisk ??
    0
  );
}

function timingOf(signal = {}) {
  return String(
    signal.entryTiming ??
    signal.timing ??
    signal.entryQuality?.timing ??
    signal.entryQuality ??
    ""
  ).toUpperCase();
}

function isActionableTiming(signal = {}) {
  const t = timingOf(signal);
  return (
    t.includes("IDEAL") ||
    t.includes("ENTRY_ZONE") ||
    t.includes("VALID") ||
    t.includes("SCALP") ||
    t === "A" ||
    t === "B"
  );
}

function isTooEarly(signal = {}) {
  const t = timingOf(signal);
  return t.includes("TOO_EARLY") || t.includes("EARLY");
}

export function rememberRetraceCandidate(signal = {}, engine = "unknown") {
  const pair = pairKey(signal);
  const confidence = confidenceOf(signal);

  if (!pair || confidence < MIN_CONFIDENCE || !isTooEarly(signal)) {
    return false;
  }

  if (!watched.has(pair) && watched.size >= MAX_WATCHED) {
    const oldest = [...watched.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
    if (oldest) watched.delete(oldest[0]);
  }

  watched.set(pair, {
    pair,
    engine,
    confidence,
    firstSignal: signal,
    createdAt: now(),
    updatedAt: now(),
    reason: "High-confidence setup waiting for retracement into entry zone",
  });

  console.log(`[RETRACE_WATCH] watching ${pair} engine=${engine} confidence=${confidence} timing=${timingOf(signal)}`);
  return true;
}

export function shouldPrioritizePair(pair) {
  cleanupRetraceWatch();
  return watched.has(pair);
}

export function getRetraceWatchPairs() {
  cleanupRetraceWatch();
  return [...watched.keys()];
}

export function clearRetraceWatch(pair, reason = "cleared") {
  if (watched.delete(pair)) {
    console.log(`[RETRACE_WATCH] cleared ${pair}: ${reason}`);
  }
}

export function cleanupRetraceWatch() {
  const cutoff = now() - TTL_MS;
  for (const [pair, item] of watched.entries()) {
    if (item.createdAt < cutoff) {
      watched.delete(pair);
      console.log(`[RETRACE_WATCH] expired ${pair}`);
    }
  }
}

export function evaluateRetraceCandidate(signal = {}, engine = "unknown") {
  const pair = pairKey(signal);
  const confidence = confidenceOf(signal);
  const rr = rrOf(signal);

  if (!pair || confidence < MIN_CONFIDENCE) {
    return { action: "ignore", reason: "below confidence threshold" };
  }

  if (isTooEarly(signal)) {
    rememberRetraceCandidate(signal, engine);
    return { action: "watch", reason: "waiting for retracement entry zone" };
  }

  if (watched.has(pair) && isActionableTiming(signal)) {
    if (rr >= MIN_RR) {
      clearRetraceWatch(pair, "entry zone reached and RR valid");
      return { action: "execute", reason: "watched pair entered entry zone with valid RR" };
    }

    return {
      action: "hold",
      reason: `entry zone reached but RR ${rr} < ${MIN_RR}`,
    };
  }

  return { action: "normal", reason: "not a retrace-watch condition" };
}
