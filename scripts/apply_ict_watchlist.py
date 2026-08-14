#!/usr/bin/env python3
"""Enforce the ICT-owned watchlist and analysis-only instrument safeguards.

The repository runs idempotent source-enforcement scripts during pretest,
prebuild, and prestart. This patch keeps the ICT engine on its own watchlist,
routes XAU/USD, US30 and US500 through the analysis market-data adapter, and
prevents those signal-only instruments from reaching OANDA execution.
"""

from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT / "server" / "ictEngine.js"
EXECUTION = ROOT / "server" / "ictExecution.js"
AUTO_TRADE = ROOT / "server" / "ictAutoTrade.js"
ACCOUNT_ISOLATION = ROOT / "scripts" / "apply_account_engine_isolation.mjs"
SIGNAL_FORENSICS = ROOT / "scripts" / "apply_signal_forensics_alignment_v3.mjs"

WATCHLIST_IMPORT = "import { configuredIctWatchlist } from './ictWatchlist.js';"
CATALOG_IMPORT = "import { getIctInstrumentMeta } from './ictInstrumentCatalog.js';"
MARKET_DATA_IMPORT = "import { getIctCandles } from './ictMarketData.js';"
ELIGIBILITY_IMPORT = "import { configuredIctWatchlist, isIctExecutionEligibleInstrument } from './ictWatchlist.js';"

OLD_WATCHLIST_BLOCK = re.compile(
    r"const DEFAULT_ICT_PAIRS = \[[^\n]+\];\n"
    r"const ICT_PAIRS = \(process\.env\.ICT_PAIRS \|\| process\.env\.FOREX_WATCHLIST\)\n"
    r"  \? \(process\.env\.ICT_PAIRS \|\| process\.env\.FOREX_WATCHLIST\)\.split\(','\)\.map\(\(p\) => p\.trim\(\)\)\.filter\(Boolean\)\n"
    r"  : DEFAULT_ICT_PAIRS;"
)
NEW_WATCHLIST_BLOCK = "const ICT_PAIRS = configuredIctWatchlist();"

DISPLAY_QUALIFICATION_OLD = """    if (isIctAutoQualified(item, cfg)) {
      hotPairs.add(pair);
      continue;
    }"""
DISPLAY_QUALIFICATION_NEW = """    const displayQualified = item?.signal !== 'none' &&
      Number.isFinite(Number(item?.confidence)) && Number(item.confidence) >= cfg.minConfidence &&
      Number.isFinite(Number(item?.rr)) && Number(item.rr) >= cfg.minRR;
    if (displayQualified) {
      hotPairs.add(pair);
      continue;
    }"""


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old in text:
        return text.replace(old, new, 1)
    if new in text:
        return text
    raise SystemExit(f"ICT analysis instrument patch failed: {label}")


def patch_engine() -> None:
    text = ENGINE.read_text(encoding="utf-8")

    text = replace_once(
        text,
        "import { getCandles } from './oandaMarketData.js';",
        MARKET_DATA_IMPORT,
        "ICT market-data import anchor not found",
    )

    if WATCHLIST_IMPORT not in text:
        anchor = "import { getNewsRisk } from './news/forexFactoryNews.js';"
        if anchor not in text:
            raise SystemExit("ICT watchlist patch failed: news import anchor not found")
        text = text.replace(anchor, f"{anchor}\n{WATCHLIST_IMPORT}", 1)

    if CATALOG_IMPORT not in text:
        text = text.replace(WATCHLIST_IMPORT, f"{WATCHLIST_IMPORT}\n{CATALOG_IMPORT}", 1)

    if OLD_WATCHLIST_BLOCK.search(text):
        text = OLD_WATCHLIST_BLOCK.sub(NEW_WATCHLIST_BLOCK, text, count=1)
    elif NEW_WATCHLIST_BLOCK not in text:
        raise SystemExit("ICT watchlist patch failed: old/default watchlist block not found")

    text = text.replace(
        "getCandles(pair, g, n, { client }).catch(() => [])",
        "getIctCandles(pair, g, n, { client }).catch(() => [])",
    )
    text = text.replace(
        "TF.map(([key, g, n]) => getCandles(",
        "TF.map(([key, g, n]) => getIctCandles(",
    )

    signal_anchor = "  const signalId = `${pair}:${generatedAtMs}`;\n"
    meta_line = "  const instrumentMeta = getIctInstrumentMeta(pair);\n"
    if meta_line not in text:
        if signal_anchor not in text:
            raise SystemExit("ICT instrument metadata anchor not found")
        text = text.replace(signal_anchor, f"{signal_anchor}{meta_line}", 1)

    text = replace_once(
        text,
        "  const ictNarrative = buildNarrative({ pair, dir, bias, sweep, displacement, mss, choch, premiumDiscount, ote, kz, irlErl, signal, setupType });",
        "  const ictNarrative = buildNarrative({ pair: instrumentMeta.displaySymbol, dir, bias, sweep, displacement, mss, choch, premiumDiscount, ote, kz, irlErl, signal, setupType });",
        "friendly ICT narrative symbol anchor not found",
    )

    return_anchor = "  return {\n    pair, timestamp, signalId, generatedAtMs,\n    strategy: 'SCALP',"
    return_replacement = "  return {\n    pair,\n    displaySymbol: instrumentMeta.displaySymbol,\n    assetClass: instrumentMeta.assetClass,\n    marketDataSource: instrumentMeta.sourceLabel,\n    marketDataProxySymbol: instrumentMeta.sourceSymbol,\n    executionEligible: instrumentMeta.executionEligible,\n    pricePrecision: instrumentMeta.pricePrecision,\n    timestamp, signalId, generatedAtMs,\n    strategy: 'SCALP',"
    text = replace_once(text, return_anchor, return_replacement, "ICT analysis metadata return anchor not found")

    blank_anchor = "function blankAnalysis(pair, timestamp, reason) {\n  const generatedAtMs = Date.parse(timestamp) || 0;\n  return {\n    pair, timestamp, signalId: `${pair}:${generatedAtMs}`, generatedAtMs,\n    ictBias: 'neutral', ictNarrative: `${pair}: ${reason}`,"
    blank_replacement = "function blankAnalysis(pair, timestamp, reason) {\n  const generatedAtMs = Date.parse(timestamp) || 0;\n  const instrumentMeta = getIctInstrumentMeta(pair);\n  return {\n    pair,\n    displaySymbol: instrumentMeta.displaySymbol,\n    assetClass: instrumentMeta.assetClass,\n    marketDataSource: instrumentMeta.sourceLabel,\n    marketDataProxySymbol: instrumentMeta.sourceSymbol,\n    executionEligible: instrumentMeta.executionEligible,\n    pricePrecision: instrumentMeta.pricePrecision,\n    timestamp, signalId: `${pair}:${generatedAtMs}`, generatedAtMs,\n    ictBias: 'neutral', ictNarrative: `${instrumentMeta.displaySymbol}: ${reason}`,"
    blank_start = text.find("function blankAnalysis(pair, timestamp, reason) {")
    blank_end = text.find("// ─── Batch", blank_start)
    blank_block = text[blank_start:blank_end] if blank_start >= 0 and blank_end > blank_start else ""
    if blank_anchor in text:
        text = text.replace(blank_anchor, blank_replacement, 1)
    elif not (
        "const instrumentMeta = getIctInstrumentMeta(pair);" in blank_block
        and "displaySymbol: instrumentMeta.displaySymbol" in blank_block
        and "ictNarrative: `${instrumentMeta.displaySymbol}: ${reason}`" in blank_block
    ):
        raise SystemExit("ICT analysis instrument patch failed: blank ICT metadata anchor not found")

    if "DEFAULT_ICT_PAIRS" in text:
        raise SystemExit("ICT watchlist patch failed: retired default constant remains")
    if text.count(WATCHLIST_IMPORT) != 1 or text.count(CATALOG_IMPORT) != 1:
        raise SystemExit("ICT analysis imports are not unique")
    if text.count(NEW_WATCHLIST_BLOCK) != 1:
        raise SystemExit("ICT configured watchlist assignment is not unique")
    if "getCandles(pair, g, n, { client })" in text or "=> getCandles(" in text:
        raise SystemExit("ICT batch still calls OANDA candles directly")

    ENGINE.write_text(text, encoding="utf-8")


def patch_execution() -> None:
    text = EXECUTION.read_text(encoding="utf-8")
    if ELIGIBILITY_IMPORT not in text:
        anchor = "import { analyzeICTPair, ictExecConfig } from './ictEngine.js';"
        if anchor not in text:
            raise SystemExit("ICT execution eligibility import anchor not found")
        text = text.replace(anchor, f"{anchor}\n{ELIGIBILITY_IMPORT}", 1)

    log_anchor = "  rec(`requested pair=${pair} dir=${direction} entry=${entry} sl=${stopLoss} tp=${targetProfit} id=${ictSignalId} env=${tradingEnv}`);\n"
    block = (
        "  if (!isIctExecutionEligibleInstrument(pair)) {\n"
        "    return blocked(`${pair || 'Unknown instrument'} is signal-only in ICT Intelligence and cannot be routed to OANDA execution.`);\n"
        "  }\n"
    )
    if block not in text:
        if log_anchor not in text:
            raise SystemExit("ICT execution signal-only block anchor not found")
        text = text.replace(log_anchor, f"{log_anchor}\n{block}", 1)

    EXECUTION.write_text(text, encoding="utf-8")


def patch_auto_trade() -> None:
    text = AUTO_TRADE.read_text(encoding="utf-8")
    if ELIGIBILITY_IMPORT not in text:
        anchor = "import { executeIctTrade } from './ictExecution.js';"
        if anchor not in text:
            raise SystemExit("ICT Auto AI eligibility import anchor not found")
        text = text.replace(anchor, f"{anchor}\n{ELIGIBILITY_IMPORT}", 1)

    text = replace_once(
        text,
        DISPLAY_QUALIFICATION_OLD,
        DISPLAY_QUALIFICATION_NEW,
        "ICT display qualification anchor not found",
    )

    old = "  const rr = Number(analysis?.rr);\n  return analysis?.signal !== 'none' &&\n    Number.isFinite(confidence) && confidence >= cfg.minConfidence &&"
    enhanced_old = "  const rr = Number(analysis?.rr);\n  return analysis?.executionEligible !== false &&"
    new = "  const rr = Number(analysis?.rr);\n  const pairEligible = analysis?.pair\n    ? isIctExecutionEligibleInstrument(analysis.pair)\n    : analysis?.executionEligible !== false;\n  return pairEligible &&\n    analysis?.executionEligible !== false &&"
    current_qualification = (
        "const pairEligible = analysis?.pair" in text
        and "isIctExecutionEligibleInstrument(analysis.pair)" in text
        and "return pairEligible &&" in text
    )
    if new not in text and not current_qualification:
        if enhanced_old in text:
            text = text.replace(enhanced_old, new, 1)
        elif old in text:
            text = text.replace(old, new + "\n    analysis?.signal !== 'none' &&\n    Number.isFinite(confidence) && confidence >= cfg.minConfidence &&", 1)
        else:
            raise SystemExit("ICT analysis instrument patch failed: ICT Auto AI qualification anchor not found")
    AUTO_TRADE.write_text(text, encoding="utf-8")


def patch_account_isolation_markers() -> None:
    """Allow the downstream generator to accept a combined watchlist import."""
    text = ACCOUNT_ISOLATION.read_text(encoding="utf-8")
    exact_marker = '    "import { configuredIctWatchlist } from \'./ictWatchlist.js\';",'
    flexible_marker = "    'configuredIctWatchlist',"
    if exact_marker in text:
        text = text.replace(exact_marker, flexible_marker)
    if exact_marker in text:
        raise SystemExit("ICT account-isolation marker compatibility patch failed")
    ACCOUNT_ISOLATION.write_text(text, encoding="utf-8")


def patch_signal_forensics_generator() -> None:
    """Keep the later generator's replacement source identical and idempotent."""
    text = SIGNAL_FORENSICS.read_text(encoding="utf-8")
    text = replace_once(
        text,
        DISPLAY_QUALIFICATION_OLD,
        DISPLAY_QUALIFICATION_NEW,
        "signal-forensics display qualification anchor not found",
    )
    SIGNAL_FORENSICS.write_text(text, encoding="utf-8")


def main() -> None:
    patch_engine()
    patch_execution()
    patch_auto_trade()
    patch_account_isolation_markers()
    patch_signal_forensics_generator()
    print("ICT watchlist enforced: 4 executable FX pairs + XAU/USD, US30 and US500 signal-only analysis")


if __name__ == "__main__":
    main()
