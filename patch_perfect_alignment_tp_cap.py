from pathlib import Path
import re
import sys

FILE = Path("server/oandaTradeLifecycle.js")

def die(msg):
    print(f"❌ {msg}", file=sys.stderr)
    sys.exit(1)

if not FILE.exists():
    die("server/oandaTradeLifecycle.js not found. Run from repo root.")

text = FILE.read_text()
original = text

old = """  // Compute final R:R and decide whether to accept
  const riskReward = +(takeProfitPips / stopLossPips).toFixed(2);
  let allowed = true;
  let rejectionReason = null;
  if (riskReward < MIN_RISK_REWARD) {
    allowed = false;
    rejectionReason = cappedByKeyLevel
      ? `TP capped by H4 key level at ${keyLevelDistance}p — final R:R ${riskReward} < min ${MIN_RISK_REWARD}`
      : `Final R:R ${riskReward} < min ${MIN_RISK_REWARD}`;
  }
"""

new = """  // Compute final R:R and decide whether to accept.
  // Perfect primary alignment should not be crushed by a nearby H4 level cap.
  // If the original target had enough room for >= 1.5R, convert the H4 cap into
  // a warning and restore the minimum valid target instead of rejecting.
  let riskReward = +(takeProfitPips / stopLossPips).toFixed(2);
  let allowed = true;
  let rejectionReason = null;

  const perfectPrimaryAlignment = Number(alignment?.timeframeAlignmentScore ?? 0) >=
    Number(process.env.FOREX_PERFECT_ALIGNMENT_BYPASS_SCORE || 100);

  if (
    perfectPrimaryAlignment &&
    cappedByKeyLevel &&
    riskReward < MIN_RISK_REWARD
  ) {
    const minValidTpPips = Math.ceil(stopLossPips * MIN_RISK_REWARD);

    takeProfitPips = minValidTpPips;
    riskReward = +(takeProfitPips / stopLossPips).toFixed(2);
    cappedByKeyLevel = false;

    rrMultipliers.push(
      `perfect-alignment-key-level-warning@${keyLevelDistance}p`
    );

    targetReason +=
      ` · Perfect alignment: nearby H4 key level at ${keyLevelDistance}p treated as warning, not TP cap`;
  }

  if (riskReward < MIN_RISK_REWARD) {
    allowed = false;
    rejectionReason = cappedByKeyLevel
      ? `TP capped by H4 key level at ${keyLevelDistance}p — final R:R ${riskReward} < min ${MIN_RISK_REWARD}`
      : `Final R:R ${riskReward} < min ${MIN_RISK_REWARD}`;
  }
"""

if old not in text:
    die("Could not find exact R:R decision block in server/oandaTradeLifecycle.js")

text = text.replace(old, new, 1)

backup = FILE.with_suffix(".js.bak_tp_cap")
backup.write_text(original)
FILE.write_text(text)

print("✅ Patched H4 TP cap for perfect-alignment setups.")
print(f"🗂️ Backup saved: {backup}")
