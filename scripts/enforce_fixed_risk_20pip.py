#!/usr/bin/env python3
"""Idempotently enforce the broker-bound 1.25% / 20-pip forex risk policy.

The repository already applies source hardening scripts before dev, test, build,
and production start. This patch intentionally runs last so older generated
patches cannot restore dynamic risk or lifecycle-sized stops afterward.
"""

from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]


def read(rel):
    return (ROOT / rel).read_text()


def write(rel, text):
    (ROOT / rel).write_text(text)
    print(f"[fixed-risk-20pip] patched {rel}")


def replace_once(text, old, new, label):
    count = text.count(old)
    if count == 0:
        if new in text:
            return text
        raise RuntimeError(f"{label}: expected source text not found")
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, found {count}")
    return text.replace(old, new, 1)


def regex_once(text, pattern, replacement, label, flags=0):
    updated, count = re.subn(pattern, replacement, text, count=1, flags=flags)
    if count == 0:
        if replacement in text:
            return text
        raise RuntimeError(f"{label}: expected regex match not found")
    return updated


def patch_risk_manager():
    rel = "server/riskManager.js"
    text = read(rel)

    import_line = "import { FIXED_RISK_PER_TRADE_PERCENT } from './fixedTradeRiskPolicy.js';\n\n"
    if import_line not in text:
        text = replace_once(
            text,
            "// Exact operator-facing message required when a margin restriction would be hit.\n",
            import_line + "// Exact operator-facing message required when a margin restriction would be hit.\n",
            "riskManager fixed-policy import",
        )

    text = regex_once(
        text,
        r"const RISK_TOLERANCE = [^;]+;[^\n]*",
        "const RISK_TOLERANCE = 0; // never authorize planned risk above 1.25%",
        "riskManager zero tolerance",
    )
    text = regex_once(
        text,
        r"maxRiskPerTradePercent:\s*parseFloat\([^\n]+\),",
        "maxRiskPerTradePercent: FIXED_RISK_PER_TRADE_PERCENT,",
        "riskManager immutable cap",
    )
    write(rel, text)


def patch_risk_sizing():
    rel = "server/oandaRiskSizing.js"
    text = read(rel)

    text = replace_once(
        text,
        "export function dollarPerPipPerUnit(pair, entryPrice) {\n  const pipSize = getPipSize(pair);\n",
        "export function dollarPerPipPerUnit(pair, entryPrice, lossQuoteHomeConversionFactor = null) {\n"
        "  const pipSize = getPipSize(pair);\n"
        "  const brokerLossFactor = Number(lossQuoteHomeConversionFactor);\n"
        "  if (Number.isFinite(brokerLossFactor) && brokerLossFactor > 0) {\n"
        "    return pipSize * brokerLossFactor;\n"
        "  }\n",
        "risk sizing broker conversion",
    )

    text = replace_once(
        text,
        "  accountMarginRate = 0,\n  accountBalanceUSD = null,\n}) {",
        "  accountMarginRate = 0,\n  accountBalanceUSD = null,\n  lossQuoteHomeConversionFactor = null,\n}) {",
        "risk sizing conversion argument",
    )
    text = replace_once(
        text,
        "  const pipUsdPerUnit         = dollarPerPipPerUnit(pair, entryPrice);",
        "  const pipUsdPerUnit         = dollarPerPipPerUnit(pair, entryPrice, lossQuoteHomeConversionFactor);",
        "risk sizing conversion use",
    )
    text = replace_once(
        text,
        "    pipValuePerStandardLot: +pipUsdPerStandardLot.toFixed(4),\n",
        "    pipValuePerStandardLot: +pipUsdPerStandardLot.toFixed(4),\n"
        "    lossQuoteHomeConversionFactor: Number.isFinite(Number(lossQuoteHomeConversionFactor))\n"
        "      ? Number(lossQuoteHomeConversionFactor)\n"
        "      : null,\n",
        "risk sizing conversion output",
    )
    write(rel, text)


def patch_oanda_trade():
    rel = "server/oandaTrade.js"
    text = read(rel)

    text = replace_once(
        text,
        "  capPerTradeRiskPercent,\n",
        "  capPerTradeRiskPercent,\n  computeRiskBudgetUSD,\n",
        "oandaTrade risk budget import",
    )

    helper_import = (
        "import {\n"
        "  FIXED_RISK_PER_TRADE_PERCENT,\n"
        "  FIXED_STOP_LOSS_PIPS,\n"
        "  enforceFixedStopGeometry,\n"
        "  buildFixedStopLossOnFill,\n"
        "  getLossQuoteHomeConversionFactor,\n"
        "} from './fixedTradeRiskPolicy.js';\n"
    )
    if helper_import not in text:
        text = replace_once(
            text,
            "import { HARD_SCALP_CONFIDENCE_FLOOR, isExplicitSwingSignal, normalizeScalpLifecycle } from './scalpOnlyPolicy.js';\n",
            "import { HARD_SCALP_CONFIDENCE_FLOOR, isExplicitSwingSignal, normalizeScalpLifecycle } from './scalpOnlyPolicy.js';\n" + helper_import,
            "oandaTrade fixed-policy import",
        )

    fixed_risk_block = """  // FINAL AUTHORITY: every submitted trade targets exactly 1.25% of live balance.
  // Confidence, engine, setup score, environment variables, and manual/API callers
  // cannot raise or lower this broker-bound risk budget.
  const dynamicRisk = {
    allowed: true,
    riskPercent: FIXED_RISK_PER_TRADE_PERCENT,
    riskUSD: computeRiskBudgetUSD(balanceUSD),
    factors: {
      confidence: signal.confidence,
      score: signal.score,
      spreadPips: signal.spreadPips,
      maxSpreadPips: maxSpread,
      volatilityState: signal.volatilityState,
      modifiers: ['fixed-1.25%-execution-policy'],
    },
  };

  let openTradesForBudget"""
    text = regex_once(
        text,
        r"  const dynamicRisk = computeDynamicTradeRisk\(\{.*?\n  \}\n\n  let openTradesForBudget",
        fixed_risk_block,
        "oandaTrade replace dynamic risk",
        flags=re.S,
    )

    text = replace_once(
        text,
        "  if (dailyBudget.capped) {\n"
        "    dynamicRisk.riskUSD = dailyBudget.approvedRiskUSD;\n"
        "    dynamicRisk.riskPercent = +((dailyBudget.approvedRiskUSD / balanceUSD) * 100).toFixed(4);\n"
        "  }",
        "  if (dailyBudget.capped) {\n"
        "    return blocked(\n"
        "      `Full fixed ${FIXED_RISK_PER_TRADE_PERCENT}% risk is unavailable within the remaining daily loss budget; ` +\n"
        "      `requested=$${dynamicRisk.riskUSD.toFixed(2)} approved=$${dailyBudget.approvedRiskUSD.toFixed(2)}. Trade blocked.`\n"
        "    );\n"
        "  }",
        "oandaTrade reject partial daily risk",
    )

    geometry_needle = (
        "  slPips = scalpLifecycle.lifecycle.sl.stopLossPips;\n"
        "  slPriceFromLifecycle = scalpLifecycle.lifecycle.sl.stopLossPrice;\n"
        "  tpPips = scalpLifecycle.lifecycle.tp.takeProfitPips;\n"
        "  tpPriceFromLifecycle = scalpLifecycle.lifecycle.tp.takeProfitPrice;\n"
    )
    geometry_insert = geometry_needle + (
        "\n  // FINAL AUTHORITY: lifecycle/engine stops are advisory only. OANDA receives\n"
        "  // an exact 20-pip stop and a TP that remains at or above the hard RR floor.\n"
        "  const fixedGeometry = enforceFixedStopGeometry({\n"
        "    pair, direction, entry: executableEntry, takeProfit: tpPriceFromLifecycle,\n"
        "    minRR: MIN_EXECUTABLE_RR, priceDecimals,\n"
        "  });\n"
        "  slPips = fixedGeometry.stopLossPips;\n"
        "  slPriceFromLifecycle = fixedGeometry.stopLoss;\n"
        "  tpPips = fixedGeometry.takeProfitPips;\n"
        "  tpPriceFromLifecycle = fixedGeometry.takeProfit;\n"
        "  signal.stopLoss = slPriceFromLifecycle;\n"
        "  signal.takeProfit = tpPriceFromLifecycle;\n"
        "  console.log(`[FIXED_RISK_POLICY] ${pair} ${direction} risk=${FIXED_RISK_PER_TRADE_PERCENT}% SL=${FIXED_STOP_LOSS_PIPS}p TP=${tpPips}p RR=${fixedGeometry.riskReward}`);\n"
    )
    text = replace_once(text, geometry_needle, geometry_insert, "oandaTrade fixed geometry")

    sizing_needle = "  const sizing = computeFixedDollarSizing({\n"
    sizing_insert = (
        "  let lossQuoteHomeConversionFactor;\n"
        "  try {\n"
        "    lossQuoteHomeConversionFactor = await getLossQuoteHomeConversionFactor({\n"
        "      pair, client, homeCurrency: account.currency || 'USD',\n"
        "    });\n"
        "  } catch (err) {\n"
        "    return blocked(`Could not calculate broker home-currency stop risk: ${err.message}`);\n"
        "  }\n\n"
        + sizing_needle
    )
    text = replace_once(text, sizing_needle, sizing_insert, "oandaTrade conversion fetch")
    text = replace_once(
        text,
        "    accountBalanceUSD: balanceUSD,\n  });",
        "    accountBalanceUSD: balanceUSD,\n"
        "    lossQuoteHomeConversionFactor,\n"
        "  });",
        "oandaTrade conversion sizing argument",
    )

    strict_margin_block = """  if (autoAi) {
    const fit = fitUnitsToMargin({
      signedUnits: units,
      estimatedMargin,
      marginAvailable,
      minFreeMarginUSD,
    });
    if (fit.changed) {
      return blocked(
        `Full fixed ${FIXED_RISK_PER_TRADE_PERCENT}% position does not fit the required free-margin reserve; ` +
        `refusing to silently resize units (${units} -> ${fit.signedUnits}).`
      );
    }
  }

  if (!absUnits"""
    text = regex_once(
        text,
        r"  if \(autoAi\) \{\n    const fit = fitUnitsToMargin\(\{.*?\n  \}\n\n  if \(!absUnits",
        strict_margin_block,
        "oandaTrade reject margin downsizing",
        flags=re.S,
    )

    order_needle = (
        "  const orderPayload = buildOandaMarketOrderPayload({\n"
        "    pair,\n"
        "    signedUnits: units,\n"
        "    stopLoss: slPrice,\n"
        "    takeProfit: tpPrice,\n"
        "    priceDecimals,\n"
        "  });\n"
    )
    order_insert = order_needle + (
        "  // Use fill-relative distance so OANDA places the stop exactly 20 pips\n"
        "  // from the actual market fill instead of from a stale pre-fill quote.\n"
        "  orderPayload.order.stopLossOnFill = buildFixedStopLossOnFill({ pair, priceDecimals });\n"
    )
    text = replace_once(text, order_needle, order_insert, "oandaTrade fill-relative stop")

    fill_needle = (
        "  const tradeMarginUsed = parseFloat(\n"
        "    fillInfo.initialMarginRequired || fillInfo.marginRequired || 0\n"
        "  );\n"
    )
    fill_insert = fill_needle + (
        "  const actualStopPrice = Number((direction === 'long'\n"
        "    ? fillPrice - FIXED_STOP_LOSS_PIPS * pipSize\n"
        "    : fillPrice + FIXED_STOP_LOSS_PIPS * pipSize\n"
        "  ).toFixed(priceDecimals));\n"
    )
    text = replace_once(text, fill_needle, fill_insert, "oandaTrade actual fill stop")

    marker = "  const actualStopPrice = Number((direction === 'long'"
    start = text.find(marker)
    if start < 0:
        raise RuntimeError("oandaTrade post-fill marker missing")
    head, tail = text[:start], text[start:]
    tail = tail.replace("stopLoss: slPrice", "stopLoss: actualStopPrice")
    text = head + tail

    text = text.replace(
        "// ── Central hard risk-per-trade validation (actual sized risk ≤ 1.4%)",
        "// ── Central hard risk-per-trade validation (actual sized risk ≤ 1.25%)",
    )
    write(rel, text)


def patch_ict_execution():
    rel = "server/ictExecution.js"
    text = read(rel)

    text = replace_once(
        text,
        "  capPerTradeRiskPercent,\n",
        "  capPerTradeRiskPercent,\n  computeRiskBudgetUSD,\n",
        "ict risk budget import",
    )
    helper_import = (
        "import {\n"
        "  FIXED_RISK_PER_TRADE_PERCENT,\n"
        "  enforceFixedStopGeometry,\n"
        "  buildFixedStopLossOnFill,\n"
        "  getLossQuoteHomeConversionFactor,\n"
        "} from './fixedTradeRiskPolicy.js';\n"
    )
    if helper_import not in text:
        text = replace_once(
            text,
            "import { isExplicitSwingSignal } from './scalpOnlyPolicy.js';\n",
            "import { isExplicitSwingSignal } from './scalpOnlyPolicy.js';\n" + helper_import,
            "ict fixed-policy import",
        )

    fixed_block = """  const pipSize = getPipSize(pair);
  const dp = priceDecimalsFor(pair);
  const fixedGeometry = enforceFixedStopGeometry({
    pair, direction, entry, takeProfit: targetProfit, minRR: config.minRR, priceDecimals: dp,
  });
  const slPips = fixedGeometry.stopLossPips;
  const tpPips = fixedGeometry.takeProfitPips;
  const enforcedStopLoss = fixedGeometry.stopLoss;
  const enforcedTargetProfit = fixedGeometry.takeProfit;
  const requestedRiskUSD = computeRiskBudgetUSD(balanceUSD);
  let openTradesForBudget = [];
  try { const openFn = getOpen || (() => getOpenTrades({ client })); openTradesForBudget = (await openFn()) || []; } catch (err) { return blocked(`Could not calculate open stop risk: ${err.message}`); }
  const dailyBudget = reserveDailyLossBudget({ accountId: client.accountId, balanceUSD, openRiskUSD: computeOpenRiskUSD(openTradesForBudget), requestedRiskUSD, now });
  if (!dailyBudget.allowed) return blocked(dailyBudget.reason);
  if (dailyBudget.capped) {
    return blocked(
      `Full fixed ${FIXED_RISK_PER_TRADE_PERCENT}% risk is unavailable within the remaining daily loss budget; ` +
      `requested=$${requestedRiskUSD.toFixed(2)} approved=$${dailyBudget.approvedRiskUSD.toFixed(2)}. Trade blocked.`
    );
  }
  const targetRiskUSD = requestedRiskUSD;
  let lossQuoteHomeConversionFactor;
  try {
    lossQuoteHomeConversionFactor = await getLossQuoteHomeConversionFactor({
      pair, client, homeCurrency: account.currency || 'USD',
    });
  } catch (err) {
    return blocked(`Could not calculate broker home-currency stop risk: ${err.message}`);
  }
  const sizing = computeFixedDollarSizing({
    pair, direction, entryPrice: entry, targetRiskUSD,
    stopLossPips: slPips, stopLossPrice: enforcedStopLoss,
    takeProfitPips: tpPips, takeProfitPrice: enforcedTargetProfit,
    accountMarginRate: parseFloat(account?.marginRate ?? 0),
    accountBalanceUSD: balanceUSD,
    lossQuoteHomeConversionFactor,
  });
  const units"""
    text = regex_once(
        text,
        r"  const pipSize = getPipSize\(pair\);\n  const slPips = .*?\n  const units",
        fixed_block,
        "ict fixed risk and geometry",
        flags=re.S,
    )

    text = replace_once(
        text,
        "    stopLoss,\n    targetProfit,\n  });",
        "    stopLoss: enforcedStopLoss,\n    targetProfit: enforcedTargetProfit,\n  });",
        "ict protective geometry",
    )
    text = replace_once(
        text,
        "  const dp = priceDecimalsFor(pair);\n  const orderPayload = {",
        "  const orderPayload = {",
        "ict remove duplicate decimals",
    )
    text = replace_once(
        text,
        "      stopLossOnFill: { price: stopLoss.toFixed(dp), timeInForce: 'GTC' },\n"
        "      takeProfitOnFill: { price: targetProfit.toFixed(dp), timeInForce: 'GTC' },",
        "      stopLossOnFill: buildFixedStopLossOnFill({ pair, priceDecimals: dp }),\n"
        "      takeProfitOnFill: { price: enforcedTargetProfit.toFixed(dp), timeInForce: 'GTC' },",
        "ict fill-relative stop",
    )
    text = replace_once(
        text,
        "    const executionSignal = { ...analysis, pair, direction, entry, stopLoss, takeProfit: targetProfit };",
        "    const executionSignal = { ...analysis, pair, direction, entry, stopLoss: enforcedStopLoss, takeProfit: enforcedTargetProfit };",
        "ict execution fingerprint geometry",
    )
    text = replace_once(
        text,
        "    stopLoss, takeProfit: targetProfit,",
        "    stopLoss: enforcedStopLoss, takeProfit: enforcedTargetProfit,",
        "ict response geometry",
    )
    text = text.replace(
        "// ── 8b-ii. Hard risk-per-trade validation (actual sized risk ≤ 1.4%)",
        "// ── 8b-ii. Hard risk-per-trade validation (actual sized risk ≤ 1.25%)",
    )
    write(rel, text)


def main():
    patch_risk_manager()
    patch_risk_sizing()
    patch_oanda_trade()
    patch_ict_execution()
    print("[fixed-risk-20pip] policy enforced: risk=1.25%, stop=20 pips")


if __name__ == "__main__":
    main()
