#!/usr/bin/env python3
"""Temporary migration helper for fixed forex execution geometry.

Applies only the requested execution-management changes:
- Forex stop loss: 20.0 pips
- Forex take profit: 20.0 pips
- Executable R:R floor: 1.0
- Automatic partial close: 50% at +15.0 pips

Entry qualification, confidence, risk %, timing, engine logic, breakeven trigger,
trailing distance, and metals execution are intentionally left unchanged.
"""

from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if new in text:
        return text
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one old marker, found {count}")
    return text.replace(old, new, 1)


# Shared OANDA executor -------------------------------------------------------
path = Path("server/oandaTrade.js")
text = path.read_text(encoding="utf-8")

text = replace_once(
    text,
    "const MIN_EXECUTABLE_RR     = parseFloat(process.env.FOREX_MIN_EXECUTABLE_RR || '1.5');",
    "const MIN_EXECUTABLE_RR     = 1.0;",
    "execution RR floor",
)

floor_helper = """export function pprExecutionConfidenceFloor() {
  return HARD_SCALP_CONFIDENCE_FLOOR;
}
"""
fixed_constants = floor_helper + """
// Fixed forex execution geometry. Applied only after the existing strategy
// qualification gates accept the setup. Metals keep their existing geometry.
const FIXED_FOREX_STOP_LOSS_PIPS = 20.0;
const FIXED_FOREX_TAKE_PROFIT_PIPS = 20.0;
"""
text = replace_once(text, floor_helper, fixed_constants, "fixed forex geometry constants")

text = replace_once(
    text,
    """    if (!Number.isFinite(rr) || rr < 1.5) {
      reasons.push(`R:R ${Number.isFinite(rr) ? rr : 'n/a'} < 1.5`);
    }""",
    """    if (!Number.isFinite(rr) || rr < MIN_EXECUTABLE_RR) {
      reasons.push(`R:R ${Number.isFinite(rr) ? rr : 'n/a'} < ${MIN_EXECUTABLE_RR}`);
    }""",
    "Auto AI RR gate",
)

geometry_anchor = """  slPips = scalpLifecycle.lifecycle.sl.stopLossPips;
  slPriceFromLifecycle = scalpLifecycle.lifecycle.sl.stopLossPrice;
  tpPips = scalpLifecycle.lifecycle.tp.takeProfitPips;
  tpPriceFromLifecycle = scalpLifecycle.lifecycle.tp.takeProfitPrice;

  const sizing = computeFixedDollarSizing({"""
geometry_replacement = """  slPips = scalpLifecycle.lifecycle.sl.stopLossPips;
  slPriceFromLifecycle = scalpLifecycle.lifecycle.sl.stopLossPrice;
  tpPips = scalpLifecycle.lifecycle.tp.takeProfitPips;
  tpPriceFromLifecycle = scalpLifecycle.lifecycle.tp.takeProfitPrice;

  // Preserve all qualification above, but make broker protection deterministic
  // for forex once a setup has been authorized.
  if (!metals) {
    slPips = FIXED_FOREX_STOP_LOSS_PIPS;
    tpPips = FIXED_FOREX_TAKE_PROFIT_PIPS;
    const fixedSlDistance = FIXED_FOREX_STOP_LOSS_PIPS * pipSize;
    const fixedTpDistance = FIXED_FOREX_TAKE_PROFIT_PIPS * pipSize;
    slPriceFromLifecycle = +(direction === 'long'
      ? executableEntry - fixedSlDistance
      : executableEntry + fixedSlDistance).toFixed(priceDecimals);
    tpPriceFromLifecycle = +(direction === 'long'
      ? executableEntry + fixedTpDistance
      : executableEntry - fixedTpDistance).toFixed(priceDecimals);

    signal.stopLoss = slPriceFromLifecycle;
    signal.takeProfit = tpPriceFromLifecycle;
    signal.targetProfit = tpPriceFromLifecycle;
    signal.expectedRR = 1.0;
    signal.rr = 1.0;
    signal.riskReward = 1.0;
    signal.lifecycle = {
      ...(signal.lifecycle || {}),
      sl: {
        ...(signal.lifecycle?.sl || {}),
        stopLossPips: FIXED_FOREX_STOP_LOSS_PIPS,
        stopLossPrice: slPriceFromLifecycle,
        fixedExecution: true,
      },
      tp: {
        ...(signal.lifecycle?.tp || {}),
        allowed: true,
        takeProfitPips: FIXED_FOREX_TAKE_PROFIT_PIPS,
        takeProfitPrice: tpPriceFromLifecycle,
        fixedExecution: true,
      },
    };
    console.log(
      `[TRADE_FIXED_GEOMETRY] ${pair} ${direction} SL=${FIXED_FOREX_STOP_LOSS_PIPS.toFixed(1)}p ` +
      `TP=${FIXED_FOREX_TAKE_PROFIT_PIPS.toFixed(1)}p RR=1.00`,
    );
  }

  const sizing = computeFixedDollarSizing({"""
text = replace_once(text, geometry_anchor, geometry_replacement, "fixed geometry application")

text = replace_once(
    text,
    """  if (!Number.isFinite(finalRiskReward) || finalRiskReward < 1.5) {
    return blocked(`Risk reward ${Number.isFinite(finalRiskReward) ? finalRiskReward : 'n/a'} < minimum 1.5 after execution sizing`);
  }""",
    """  if (!Number.isFinite(finalRiskReward) || finalRiskReward < MIN_EXECUTABLE_RR) {
    return blocked(
      `Risk reward ${Number.isFinite(finalRiskReward) ? finalRiskReward : 'n/a'} < minimum ${MIN_EXECUTABLE_RR} after execution sizing`
    );
  }""",
    "post-sizing RR gate",
)

text = replace_once(
    text,
    """  const slPrice             = sizing.stopLoss;
  const tpPrice             = sizing.takeProfit;""",
    """  let slPrice               = sizing.stopLoss;
  let tpPrice               = sizing.takeProfit;""",
    "mutable fill-anchored protection prices",
)

fill_anchor = """  const tradeMarginUsed = parseFloat(
    fillInfo.initialMarginRequired || fillInfo.marginRequired || 0
  );

  // Count and lock every confirmed broker fill immediately. A successful emergency"""
fill_replacement = """  const tradeMarginUsed = parseFloat(
    fillInfo.initialMarginRequired || fillInfo.marginRequired || 0
  );

  // Market slippage can shift on-fill protection by a fraction of a pip. Re-anchor
  // forex SL/TP to the ACTUAL fill so both are exactly 20.0 pips when accepted.
  if (!metals && tradeId) {
    const fixedSlDistance = FIXED_FOREX_STOP_LOSS_PIPS * pipSize;
    const fixedTpDistance = FIXED_FOREX_TAKE_PROFIT_PIPS * pipSize;
    const fixedSlFromFill = +(direction === 'long'
      ? fillPrice - fixedSlDistance
      : fillPrice + fixedSlDistance).toFixed(priceDecimals);
    const fixedTpFromFill = +(direction === 'long'
      ? fillPrice + fixedTpDistance
      : fillPrice - fixedTpDistance).toFixed(priceDecimals);
    const dependentOrderPath = `/v3/accounts/${accountId}/trades/${tradeId}/orders`;
    const dependentOrderBody = {
      stopLoss: { price: fixedSlFromFill.toFixed(priceDecimals), timeInForce: 'GTC' },
      takeProfit: { price: fixedTpFromFill.toFixed(priceDecimals), timeInForce: 'GTC' },
    };
    try {
      if (client) await client.put(dependentOrderPath, dependentOrderBody);
      else await oandaPut(dependentOrderPath, dependentOrderBody);
      slPrice = fixedSlFromFill;
      tpPrice = fixedTpFromFill;
      sizing.stopLoss = slPrice;
      sizing.takeProfit = tpPrice;
      sizing.stopLossPips = FIXED_FOREX_STOP_LOSS_PIPS;
      sizing.takeProfitPips = FIXED_FOREX_TAKE_PROFIT_PIPS;
      sizing.riskReward = 1.0;
      executionLog.push(logEntry('FIXED_20P_FILL_REANCHOR', {
        fillPrice,
        stopLoss: slPrice,
        takeProfit: tpPrice,
        stopLossPips: FIXED_FOREX_STOP_LOSS_PIPS,
        takeProfitPips: FIXED_FOREX_TAKE_PROFIT_PIPS,
        riskReward: 1.0,
      }));
    } catch (err) {
      // Atomic on-fill protection remains active if precision re-anchor fails.
      console.error(`[TRADE_FIXED_GEOMETRY] fill re-anchor failed for ${pair}: ${err.message}`);
      executionLog.push(logEntry('FIXED_20P_FILL_REANCHOR_FAILED', { error: err.message }));
    }
  }

  // Count and lock every confirmed broker fill immediately. A successful emergency"""
text = replace_once(text, fill_anchor, fill_replacement, "fill-price 20/20 re-anchor")

text = text.replace(
    "// Universal hard R:R gate. No scanner, V3 promotion, dashboard signal, or\n  // direct API call may execute a trade below 1.5R.",
    "// Universal execution R:R gate. Fixed forex broker geometry is 1:1;\n  // strategy qualification above remains otherwise unchanged.",
    1,
)

required = [
    "const MIN_EXECUTABLE_RR     = 1.0;",
    "const FIXED_FOREX_STOP_LOSS_PIPS = 20.0;",
    "const FIXED_FOREX_TAKE_PROFIT_PIPS = 20.0;",
    "[TRADE_FIXED_GEOMETRY]",
    "executionLog.push(logEntry('FIXED_20P_FILL_REANCHOR'",
    "finalRiskReward < MIN_EXECUTABLE_RR",
]
missing = [marker for marker in required if marker not in text]
if missing:
    raise RuntimeError(f"oandaTrade fixed geometry incomplete: {missing}")
path.write_text(text, encoding="utf-8")


# Automated exit manager -----------------------------------------------------
path = Path("server/oandaExitManager.js")
text = path.read_text(encoding="utf-8")
replacements = [
    (" *   B. 70% partial close at +PARTIAL_CLOSE_TRIGGER_PIPS", " *   B. 50% partial close at +PARTIAL_CLOSE_TRIGGER_PIPS"),
    (" *   C. Trailing stop on remaining 30% runner", " *   C. Trailing stop on remaining 50% runner"),
    ("const PARTIAL_CLOSE_TRIGGER_PIPS    = 20;", "const PARTIAL_CLOSE_TRIGGER_PIPS    = 15.0;"),
    ("const PARTIAL_CLOSE_PERCENT         = 0.70;", "const PARTIAL_CLOSE_PERCENT         = 0.50;"),
    ("// ── B. Partial close at target (70%)", "// ── B. Partial close at +15.0 pips (50%)"),
    ("// Close exactly 70%, leave at least 1 unit as runner", "// Close exactly 50%, leave at least 1 unit as runner"),
    ("[OANDA_PARTIAL_CLOSE_70]", "[OANDA_PARTIAL_CLOSE_50]"),
    ("// ── C. Trailing stop on the remaining 30% runner", "// ── C. Trailing stop on the remaining 50% runner"),
]
for old, new in replacements:
    if old in text:
        text = text.replace(old, new)
for marker in [
    "const PARTIAL_CLOSE_TRIGGER_PIPS    = 15.0;",
    "const PARTIAL_CLOSE_PERCENT         = 0.50;",
    "[OANDA_PARTIAL_CLOSE_50]",
]:
    if marker not in text:
        raise RuntimeError(f"oandaExitManager marker missing: {marker}")
if "OANDA_PARTIAL_CLOSE_70" in text or "remaining 30% runner" in text:
    raise RuntimeError("legacy partial-close markers remain")
path.write_text(text, encoding="utf-8")


# Legacy RR export -----------------------------------------------------------
path = Path("server/oandaRiskSizing.js")
text = path.read_text(encoding="utf-8")
text = replace_once(
    text,
    "export const MINIMUM_RISK_REWARD = 1.5;   // hard floor; lifecycle engine enforces",
    "export const MINIMUM_RISK_REWARD = 1.0;   // fixed forex execution floor; lifecycle qualification remains separate",
    "legacy risk sizing RR export",
)
path.write_text(text, encoding="utf-8")


# Keep prestart/prebuild source enforcement idempotent -----------------------
path = Path("scripts/apply_ppr_live_execution_alignment.py")
text = path.read_text(encoding="utf-8")
text = text.replace(
    '"const MIN_EXECUTABLE_RR     = parseFloat(process.env.FOREX_MIN_EXECUTABLE_RR || \'1.5\');",',
    '"const MIN_EXECUTABLE_RR     = 1.0;",',
)
text = text.replace(
    '"const MIN_EXECUTABLE_RR     = parseFloat(process.env.FOREX_MIN_EXECUTABLE_RR || \'1.5\');\\n" + floor_helper,',
    '"const MIN_EXECUTABLE_RR     = 1.0;\\n" + floor_helper,',
)
if "const MIN_EXECUTABLE_RR     = parseFloat(process.env.FOREX_MIN_EXECUTABLE_RR || '1.5');" in text:
    raise RuntimeError("prestart PPR script still expects legacy 1.5 executor constant")
path.write_text(text, encoding="utf-8")

print("Applied fixed forex execution: SL=20p TP=20p RR=1.0 partial=50%@+15p")
