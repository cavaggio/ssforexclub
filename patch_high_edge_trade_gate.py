from pathlib import Path
import sys

FILE = Path("server/oandaTrade.js")

if not FILE.exists():
    print("❌ server/oandaTrade.js not found. Run from repo root.", file=sys.stderr)
    sys.exit(1)

text = FILE.read_text()
original = text

# Add high-edge constants after MIN_CONFIDENCE.
old = """const MIN_CONFIDENCE        = parseFloat(process.env.FOREX_MIN_CONFIDENCE || '20');
"""
new = """const MIN_CONFIDENCE        = parseFloat(process.env.FOREX_MIN_CONFIDENCE || '20');

// High-edge Auto AI gate. R:R alone is not enough; Auto AI must have probability edge.
const AUTO_AI_MIN_ENTRY_CONFIDENCE = parseFloat(process.env.AUTO_AI_MIN_ENTRY_CONFIDENCE || '90');
const AUTO_AI_MIN_ALIGNMENT_SCORE  = parseFloat(process.env.AUTO_AI_MIN_ALIGNMENT_SCORE  || '70');
const AUTO_AI_MIN_V3_SCORE         = parseFloat(process.env.AUTO_AI_MIN_V3_SCORE         || '70');
const AUTO_AI_MIN_TP_PROBABILITY   = parseFloat(process.env.AUTO_AI_MIN_TP_PROBABILITY   || '0.60');
const AUTO_AI_MIN_TP_SL_EDGE       = parseFloat(process.env.AUTO_AI_MIN_TP_SL_EDGE       || '0.15');
"""
if old in text and "AUTO_AI_MIN_ENTRY_CONFIDENCE" not in text:
    text = text.replace(old, new, 1)

# Add helper functions after logEntry.
old = """function logEntry(phase, extra = {}) {
  return { phase, timestamp: new Date().toISOString(), ...extra };
}
"""
new = """function logEntry(phase, extra = {}) {
  return { phase, timestamp: new Date().toISOString(), ...extra };
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pickFirstNumber(...values) {
  for (const v of values) {
    const n = numOrNull(v);
    if (n !== null) return n;
  }
  return null;
}

function estimateTpProbability(signal = {}) {
  // Prefer explicit model output if available.
  const explicit = pickFirstNumber(
    signal.tpProbability,
    signal.tpProb,
    signal.lifecycle?.tpProbability,
    signal.v3?.tpProbability,
    signal.v3Eval?.tpProbability,
  );
  if (explicit !== null) return explicit > 1 ? explicit / 100 : explicit;

  // Conservative fallback from score/confidence/V3. This prevents "unknown"
  // probability from being treated as safe.
  const confidence = pickFirstNumber(signal.confidence, 0) ?? 0;
  const v3Score = pickFirstNumber(signal.v3?.score, signal.v3Eval?.score, signal.score, 0) ?? 0;
  const alignment = pickFirstNumber(
    signal.alignment?.timeframeAlignmentScore,
    signal.multiTimeframeAlignmentScore,
    signal.currentAlignmentScore,
    50,
  ) ?? 50;

  const p =
    0.25 +
    Math.max(0, Math.min(100, confidence)) * 0.0025 +
    Math.max(0, Math.min(100, v3Score)) * 0.0020 +
    Math.max(0, Math.min(100, alignment)) * 0.0015;

  return Math.max(0.05, Math.min(0.85, +p.toFixed(3)));
}

function estimateSlProbability(signal = {}) {
  const explicit = pickFirstNumber(
    signal.slProbability,
    signal.slProb,
    signal.lifecycle?.slProbability,
    signal.v3?.slProbability,
    signal.v3Eval?.slProbability,
  );
  if (explicit !== null) return explicit > 1 ? explicit / 100 : explicit;
  return +(1 - estimateTpProbability(signal)).toFixed(3);
}

function hasV3EarlyTrigger(signal = {}) {
  const v3 = signal.v3 || signal.v3Eval || signal.v3Analysis || signal.metadata?.v3 || {};
  const early = signal.earlyTrigger ?? v3.earlyTrigger;
  if (early === true) return true;

  const liq = v3.liquidity || signal.liquidity || {};
  const structure = v3.structure || signal.structure || {};
  const vol = v3.volatility || signal.volatility || {};

  return (
    liq.liquiditySweepDetected === true ||
    liq.sweepDetected === true ||
    structure.chochDetected === true ||
    structure.bosDetected === true ||
    vol.volatilityState === 'expanding' ||
    vol.volatilityState === 'compressed'
  );
}

function highEdgeAutoAiGate(signal = {}, sizing = null) {
  const reasons = [];

  const confidence = pickFirstNumber(signal.confidence, 0) ?? 0;
  const alignment = pickFirstNumber(
    signal.alignment?.timeframeAlignmentScore,
    signal.multiTimeframeAlignmentScore,
    signal.currentAlignmentScore,
    0,
  ) ?? 0;

  const v3 = signal.v3 || signal.v3Eval || signal.v3Analysis || signal.metadata?.v3 || {};
  const v3Score = pickFirstNumber(v3.score, signal.v3Score, signal.score, 0) ?? 0;

  const tpProb = estimateTpProbability(signal);
  const slProb = estimateSlProbability(signal);
  const tpEdge = +(tpProb - slProb).toFixed(3);

  const timeDecay = String(
    signal.timeDecayRisk ??
    signal.lifecycle?.timeDecayRisk ??
    signal.management?.timeDecayRisk ??
    ''
  ).toLowerCase();

  const v3Targets = v3.targets || signal.targets || {};
  const remainingOpportunityOk =
    v3Targets.accepted !== false &&
    signal.lifecycle?.tp?.allowed !== false;

  const earlyTrigger = hasV3EarlyTrigger(signal);

  if (confidence < AUTO_AI_MIN_ENTRY_CONFIDENCE) {
    reasons.push(`confidence ${confidence} < ${AUTO_AI_MIN_ENTRY_CONFIDENCE}`);
  }

  if (alignment < AUTO_AI_MIN_ALIGNMENT_SCORE) {
    reasons.push(`alignment ${alignment} < ${AUTO_AI_MIN_ALIGNMENT_SCORE}`);
  }

  if (v3Score < AUTO_AI_MIN_V3_SCORE) {
    reasons.push(`V3 score ${v3Score} < ${AUTO_AI_MIN_V3_SCORE}`);
  }

  if (tpProb < AUTO_AI_MIN_TP_PROBABILITY) {
    reasons.push(`TP probability ${(tpProb * 100).toFixed(0)}% < ${(AUTO_AI_MIN_TP_PROBABILITY * 100).toFixed(0)}%`);
  }

  if (tpEdge < AUTO_AI_MIN_TP_SL_EDGE) {
    reasons.push(`TP-SL edge ${(tpEdge * 100).toFixed(0)}% < ${(AUTO_AI_MIN_TP_SL_EDGE * 100).toFixed(0)}%`);
  }

  if (timeDecay === 'high') {
    reasons.push('time decay is high');
  }

  if (!earlyTrigger) {
    reasons.push('missing V3 early trigger');
  }

  if (!remainingOpportunityOk) {
    reasons.push('remaining opportunity rejected');
  }

  if (sizing) {
    const rr = Number(sizing?.riskReward ?? 0);
    if (!Number.isFinite(rr) || rr < 1.5) {
      reasons.push(`R:R ${Number.isFinite(rr) ? rr : 'n/a'} < 1.5`);
    }
  }

  return {
    allowed: reasons.length === 0,
    reasons,
    metrics: {
      confidence,
      alignment,
      v3Score,
      tpProb,
      slProb,
      tpEdge,
      timeDecay: timeDecay || null,
      earlyTrigger,
      remainingOpportunityOk,
    },
  };
}
"""
if old in text and "function highEdgeAutoAiGate" not in text:
    text = text.replace(old, new, 1)

# Insert gate after sizing and existing finalRiskReward guard.
needle = """  let units                 = sizing.signedUnits;
"""
insert = """  if (autoAi) {
    const edgeGate = highEdgeAutoAiGate(signal, sizing);
    executionLog.push(logEntry('HIGH_EDGE_GATE', edgeGate.metrics));

    if (!edgeGate.allowed) {
      return blocked(`High-edge Auto AI gate rejected: ${edgeGate.reasons.join('; ')}`);
    }
  }

"""
if needle in text and "HIGH_EDGE_GATE" not in text:
    text = text.replace(needle, insert + needle, 1)

if text == original:
    print("⚠️ No changes made. The patch may already be applied.")
else:
    backup = FILE.with_suffix(".js.bak_high_edge_gate")
    backup.write_text(original)
    FILE.write_text(text)
    print("✅ Added High-Edge Auto AI trade gate.")
    print(f"🗂️ Backup saved: {backup}")
