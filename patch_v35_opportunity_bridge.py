from pathlib import Path
from datetime import datetime
import shutil
import re
import sys

ROOT = Path.cwd()
STAMP = datetime.now().strftime("%Y%m%d_%H%M%S")
BACKUP = ROOT / f"backup_v35_opportunity_bridge_{STAMP}"
BACKUP.mkdir(exist_ok=True)

def backup(path):
    dest = BACKUP / path.relative_to(ROOT)
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(path, dest)

def patch_file(rel, patcher):
    path = ROOT / rel
    if not path.exists():
        print(f"❌ Missing {rel}")
        sys.exit(1)

    backup(path)
    original = path.read_text()
    updated = patcher(original)

    if updated == original:
        print(f"⚠️ No changes made to {rel}")
    else:
        path.write_text(updated)
        print(f"✅ Patched {rel}")

def patch_scanner(text):
    # 1) Let V3.5 provide direction during active window if legacy has no direction.
    marker = "      // ── ENTRY-QUALITY LAYER ─────────────────────────────────────────────"
    insert = """      // ── V3.5 ACTIVE-WINDOW DIRECTION BRIDGE ───────────────────────────────
      // If legacy momentum is too slow to produce a direction, allow V3.5 to
      // supply direction during the active opportunity window. This does NOT
      // bypass hard execution gates; it only lets the setup reach the normal
      // entry-quality, lifecycle, RR, sizing, margin, and execution layers.
      if (
        String(process.env.FOREX_ACTIVE_WINDOW_V3_BRIDGE || 'true').toLowerCase() === 'true' &&
        isActiveOpportunityWindow(new Date()) &&
        !direction &&
        v3Eval?.direction &&
        Number(v3Eval?.score ?? 0) >= Number(process.env.FOREX_ACTIVE_WINDOW_V3_MIN_SCORE || 55) &&
        (
          v3Eval?.qualified === true ||
          v3Eval?.earlyTrigger === true ||
          Number(v3Eval?.premiumDiscount?.premiumDiscountScore ?? 0) >= 0.65 ||
          Number(v3Eval?.liquidityIntent?.intentScore ?? v3Eval?.liquidityIntent?.score ?? 0) >= 0.6
        )
      ) {
        direction = v3Eval.direction;
        console.log(
          `[ACTIVE_WINDOW_V3_BRIDGE] ${pair} direction=${direction} ` +
          `v3Score=${v3Eval.score} early=${v3Eval.earlyTrigger === true} ` +
          `pd=${v3Eval?.premiumDiscount?.premiumDiscountState ?? 'n/a'}`
        );
      }

"""
    if marker in text and "V3.5 ACTIVE-WINDOW DIRECTION BRIDGE" not in text:
        text = text.replace(marker, insert + marker, 1)

    # 2) Add bridge helper functions before softenActiveWindowRejects.
    helper_marker = "function softenActiveWindowRejects(reasons = [], now = new Date()) {"
    helper = """function envBool(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function envNumber(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

function shouldUseActiveWindowV3Bridge({ v3Eval, direction, newsRisk, pricing, maxSpread, alignment } = {}) {
  if (!envBool('FOREX_ACTIVE_WINDOW_V3_BRIDGE', true)) {
    return { allowed: false, reason: 'bridge_disabled' };
  }

  if (!isActiveOpportunityWindow(new Date())) {
    return { allowed: false, reason: 'outside_active_window' };
  }

  if (!direction) {
    return { allowed: false, reason: 'missing_direction' };
  }

  if (newsRisk?.blocked) {
    return { allowed: false, reason: 'news_blocked' };
  }

  if (Number(pricing?.spreadPips ?? 999) > Number(maxSpread ?? 0)) {
    return { allowed: false, reason: 'spread_blocked' };
  }

  const score = Number(v3Eval?.score ?? 0);
  const minScore = envNumber('FOREX_ACTIVE_WINDOW_V3_MIN_SCORE', 55);
  const pdScore = Number(v3Eval?.premiumDiscount?.premiumDiscountScore ?? 0);
  const pdState = String(v3Eval?.premiumDiscount?.premiumDiscountState || '').toLowerCase();
  const liqScore = Number(v3Eval?.liquidityIntent?.intentScore ?? v3Eval?.liquidityIntent?.score ?? 0);
  const alignScore = Number(alignment?.timeframeAlignmentScore ?? 0);

  const favorablePremiumDiscount =
    (direction === 'long' && pdState === 'discount') ||
    (direction === 'short' && pdState === 'premium') ||
    pdState === 'equilibrium';

  const hasV35Opportunity =
    v3Eval?.qualified === true ||
    v3Eval?.earlyTrigger === true ||
    favorablePremiumDiscount ||
    pdScore >= 0.65 ||
    liqScore >= 0.6 ||
    alignScore >= 60;

  if (score < minScore || !hasV35Opportunity) {
    return {
      allowed: false,
      reason: `v3_not_strong_enough score=${score} min=${minScore} pd=${pdState || 'n/a'} pdScore=${pdScore} liq=${liqScore} align=${alignScore}`,
    };
  }

  return {
    allowed: true,
    reason: `v3_bridge score=${score} pd=${pdState || 'n/a'} pdScore=${pdScore} liq=${liqScore} align=${alignScore}`,
  };
}

"""
    if helper_marker in text and "function shouldUseActiveWindowV3Bridge" not in text:
        text = text.replace(helper_marker, helper + helper_marker, 1)

    # 3) Expand soft rejection list to include the blockers visible in your screenshot.
    additions = """      r.includes("structural confidence") ||
      r.includes("execution confidence") ||
      r.includes("structural reversal risk") ||
      r.includes("reversal risk is high") ||
      r.includes("candle has strong") ||
      r.includes("candle strength") ||
      r.includes("profile floor") ||
      r.includes("profile does not allow reversal_risk") ||
      r.includes("market state is reversal_risk") ||
      r.includes("forex profile does not allow reversal_risk") ||
"""
    if 'r.includes("structural confidence")' not in text:
        text = text.replace(
            '      r.includes("liquidity proxy")',
            additions + '      r.includes("liquidity proxy")',
            1
        )

    # 4) Use the bridge right before the hard rejection gate.
    gate_marker = """      const hardBlockedByEntryQuality =
        newsRisk.blocked ||
        (tradeSign && institutionalFlow.detected &&
          institutionalFlow.direction !== 'neutral' &&
          institutionalFlow.direction !== tradeSign) ||
        (ENTRY_TIMING_STRICT && entryTiming.status === 'too_early');

      if (!alignment.tradeQualified || !direction || hardBlockedByEntryQuality) {"""

    bridge_block = """      const activeWindowBridge = shouldUseActiveWindowV3Bridge({
        v3Eval,
        direction,
        newsRisk,
        pricing,
        maxSpread,
        alignment,
      });

      if (activeWindowBridge.allowed && Array.isArray(alignment.rejectionReasons)) {
        const beforeReasons = alignment.rejectionReasons.length;
        alignment.rejectionReasons = softenActiveWindowRejects(alignment.rejectionReasons, new Date());

        if (alignment.rejectionReasons.length < beforeReasons) {
          if (!Array.isArray(alignment.warnings)) alignment.warnings = [];
          alignment.warnings.push(
            `Active-window V3.5 bridge softened legacy blockers: ${activeWindowBridge.reason}`
          );

          console.log(
            `[ACTIVE_WINDOW_V3_BRIDGE] ${pair} softened ` +
            `${beforeReasons - alignment.rejectionReasons.length}/${beforeReasons} legacy blocker(s): ${activeWindowBridge.reason}`
          );
        }

        if (alignment.rejectionReasons.length === 0) {
          alignment.tradeQualified = true;
        }
      }

      const hardBlockedByEntryQuality =
        newsRisk.blocked ||
        (tradeSign && institutionalFlow.detected &&
          institutionalFlow.direction !== 'neutral' &&
          institutionalFlow.direction !== tradeSign) ||
        (ENTRY_TIMING_STRICT && entryTiming.status === 'too_early');

      if (!alignment.tradeQualified || !direction || hardBlockedByEntryQuality) {"""

    if gate_marker in text and "const activeWindowBridge = shouldUseActiveWindowV3Bridge" not in text:
        text = text.replace(gate_marker, bridge_block, 1)
    elif "const activeWindowBridge = shouldUseActiveWindowV3Bridge" in text:
        print("ℹ️ Active-window V3 bridge already inserted")
    else:
        print("❌ Could not find hard rejection gate marker in oandaScanner.js")
        sys.exit(1)

    return text

def patch_v3_auto_trade(text):
    text = text.replace(
        "const minConfidence = envNum(process.env.FOREX_V3_PROMOTE_MIN_CONFIDENCE, 70);",
        "const minConfidence = envNum(process.env.FOREX_V3_PROMOTE_MIN_CONFIDENCE, 55);"
    )
    text = text.replace(
        "const minRR = envNum(process.env.FOREX_V3_PROMOTE_MIN_RR, 1.75);",
        "const minRR = envNum(process.env.FOREX_V3_PROMOTE_MIN_RR, 1.5);"
    )
    return text

patch_file("server/oandaScanner.js", patch_scanner)
patch_file("server/v3AutoTrade.js", patch_v3_auto_trade)

print(f"\\nBackups saved in: {BACKUP}")
