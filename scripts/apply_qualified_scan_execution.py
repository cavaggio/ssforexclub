#!/usr/bin/env python3
"""Ensure every qualified PPR setup is immediately attempted and distinct pairs do not share a cooldown."""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INDEX = ROOT / "server" / "index.js"
TRADE = ROOT / "server" / "oandaTrade.js"


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if new in text:
        return text
    if old not in text:
        raise RuntimeError(f"qualified execution marker missing: {label}")
    return text.replace(old, new, 1)


index = INDEX.read_text(encoding="utf-8")
index = replace_once(
    index,
    "import { scanPprMarket } from './pprEngine.js';",
    "import { scanPprMarket } from './pprEngine.js';\nimport { executePprTrade } from './pprExecution.js';",
    "PPR execution import",
)

old_route = """// POST /api/internal/oanda/ppr-scan
// Read-only, user-scoped PPR dashboard analysis. This endpoint calls the native
// PPR raw-market scanner only and never invokes PPR execution, V3, ICT or legacy
// scanner qualification.
app.post('/api/internal/oanda/ppr-scan', async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const client = buildClientFromBody(req.body, res);
  if (!client) return;
  assertClientMatchesRequest(client, req.body);
  logInternalCall('PPR_SCAN', req.body);
  try {
    const result = await runUserScoped(
      { accountId: client.accountId, environment: client.environment },
      () => scanPprMarket({
        client,
        pairs: req.body?.pairs || null,
        now: new Date(),
        log: (message) => console.log(
          `[INTERNAL PPR_SCAN] accountId=${maskAccountId(client.accountId)} ${message}`,
        ),
      }),
    );
    console.log(
      `[INTERNAL PPR_SCAN] complete accountId=${maskAccountId(client.accountId)} ` +
        `engine=ppr architecture=independent_ppr_raw_market_data ` +
        `legacyScannerUsed=false v3LogicUsed=false ictLogicUsed=false ` +
        `qualified=${result?.qualified?.length ?? 0} ` +
        `watch=${result?.watchCandidates?.length ?? 0} ` +
        `rejected=${result?.rejected?.length ?? 0}`,
    );
    res.json(result);
  } catch (err) {
    console.error('[INTERNAL_PPR_SCAN] error:', err?.message || err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});"""

new_route = """// POST /api/internal/oanda/ppr-scan
// User-scoped PPR scan. When autoExecute=true, every signal classified as
// qualified in THIS SAME scan is immediately submitted to the native PPR
// executor. Practice/paper execution remains supported; live-only safeguards
// still apply only to live accounts.
app.post('/api/internal/oanda/ppr-scan', async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const client = buildClientFromBody(req.body, res);
  if (!client) return;
  assertClientMatchesRequest(client, req.body);
  logInternalCall('PPR_SCAN', req.body);
  try {
    const result = await runUserScoped(
      { accountId: client.accountId, environment: client.environment },
      () => scanPprMarket({
        client,
        pairs: req.body?.pairs || null,
        now: new Date(),
        log: (message) => console.log(
          `[INTERNAL PPR_SCAN] accountId=${maskAccountId(client.accountId)} ${message}`,
        ),
      }),
    );

    const autoExecute = req.body?.autoExecute === true;
    const qualified = Array.isArray(result?.qualified) ? result.qualified : [];
    const executed = [];
    const skipped = [];
    const readiness = result?.meta?.executionReadiness || null;

    if (autoExecute && readiness?.orderSubmissionReady !== false) {
      for (const signal of qualified) {
        const tradeResult = await runUserScoped(
          { accountId: client.accountId, environment: client.environment },
          () => executePprTrade(signal, {
            client,
            now: new Date(),
            log: (message) => console.log(
              `[INTERNAL PPR_EXECUTE] accountId=${maskAccountId(client.accountId)} ${message}`,
            ),
          }),
        );
        if (tradeResult?.success) {
          executed.push({
            pair: signal.pair,
            direction: signal.direction,
            confidence: signal.confidence,
            expectedRR: signal.expectedRR,
            tradeId: tradeResult.tradeId,
            fillPrice: tradeResult.fillPrice,
            units: tradeResult.units,
            stopLoss: tradeResult.sizing?.stopLoss ?? signal.stopLoss,
            takeProfit: tradeResult.sizing?.takeProfit ?? signal.takeProfit,
          });
        } else {
          skipped.push({
            pair: signal.pair,
            direction: signal.direction,
            confidence: signal.confidence,
            expectedRR: signal.expectedRR,
            reason: tradeResult?.reason || tradeResult?.rejectReason || 'execution failed',
            executionState: tradeResult?.executionState || null,
          });
        }
      }
    } else if (autoExecute) {
      const reason = readiness?.blockers?.join('; ') || 'PPR order submission is not ready';
      for (const signal of qualified) {
        skipped.push({ pair: signal.pair, direction: signal.direction, reason });
      }
    }

    const execution = {
      enabled: autoExecute,
      environment: client.environment,
      qualified: qualified.length,
      attempted: autoExecute ? qualified.length : 0,
      executed,
      skipped,
      executedCount: executed.length,
      skippedCount: skipped.length,
      allQualifiedAttempted: !autoExecute || executed.length + skipped.length === qualified.length,
    };
    result.execution = execution;
    result.meta = { ...(result.meta || {}), execution };

    console.log(
      `[INTERNAL PPR_SCAN] complete accountId=${maskAccountId(client.accountId)} ` +
        `engine=ppr architecture=independent_ppr_raw_market_data ` +
        `legacyScannerUsed=false v3LogicUsed=false ictLogicUsed=false ` +
        `qualified=${qualified.length} watch=${result?.watchCandidates?.length ?? 0} ` +
        `rejected=${result?.rejected?.length ?? 0} autoExecute=${autoExecute} ` +
        `attempted=${execution.attempted} executed=${execution.executedCount} skipped=${execution.skippedCount}`,
    );
    res.json(result);
  } catch (err) {
    console.error('[INTERNAL_PPR_SCAN] error:', err?.message || err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});"""

index = replace_once(index, old_route, new_route, "PPR scan-and-execute route")
for marker in [
    "import { executePprTrade } from './pprExecution.js';",
    "const autoExecute = req.body?.autoExecute === true;",
    "allQualifiedAttempted",
    "[INTERNAL PPR_EXECUTE]",
]:
    if marker not in index:
        raise RuntimeError(f"qualified execution route incomplete: {marker}")
INDEX.write_text(index, encoding="utf-8")


trade = TRADE.read_text(encoding="utf-8")
trade = replace_once(
    trade,
    "let lastTradeTime        = 0;\nlet dailyStartBalance    = null;\nconst activeTrades       = new Set();",
    "let lastTradeTime        = 0;\nconst lastTradeTimesByPair = new Map();\nlet dailyStartBalance    = null;\nconst activeTrades       = new Set();\n\nexport function markPairTradeCooldown(pair, atMs = Date.now()) {\n  const key = normalizePair(pair);\n  if (key) lastTradeTimesByPair.set(key, Number(atMs));\n}\n\nexport function isPairTradeCooldownActive(pair, nowMs = Date.now()) {\n  const key = normalizePair(pair);\n  const last = Number(lastTradeTimesByPair.get(key) || 0);\n  return last > 0 && Number(nowMs) - last < COOLDOWN_MS;\n}\n\nexport function clearPairTradeCooldowns() {\n  lastTradeTimesByPair.clear();\n}",
    "pair-scoped cooldown state",
)
trade = replace_once(
    trade,
    "  lastTradeTime        = 0;\n  activeTrades.clear();",
    "  lastTradeTime        = 0;\n  clearPairTradeCooldowns();\n  activeTrades.clear();",
    "cooldown reset",
)
trade = replace_once(
    trade,
    "  const now = Date.now();\n  if (now - lastTradeTime < COOLDOWN_MS) {\n    const waitSec = Math.ceil((COOLDOWN_MS - (now - lastTradeTime)) / 1000);\n    return blocked(`Cooldown active — wait ${waitSec}s before next trade`);\n  }",
    "  const now = Date.now();\n  if (isPairTradeCooldownActive(pair, now)) {\n    const pairLastTradeTime = Number(lastTradeTimesByPair.get(normalizePair(pair)) || 0);\n    const waitSec = Math.ceil((COOLDOWN_MS - (now - pairLastTradeTime)) / 1000);\n    return blocked(`Pair cooldown active for ${pair} — wait ${waitSec}s before another ${pair} trade`);\n  }",
    "pair-scoped cooldown guard",
)
trade = replace_once(
    trade,
    "  lastTradeTime = Date.now();\n  dailyTradeTimestamps.push(lastTradeTime);\n  activeTrades.add(tradeKey);",
    "  lastTradeTime = Date.now();\n  markPairTradeCooldown(pair, lastTradeTime);\n  dailyTradeTimestamps.push(lastTradeTime);\n  activeTrades.add(tradeKey);",
    "pair cooldown mark on fill",
)
for marker in [
    "const lastTradeTimesByPair = new Map();",
    "export function isPairTradeCooldownActive",
    "Pair cooldown active for ${pair}",
    "markPairTradeCooldown(pair, lastTradeTime)",
]:
    if marker not in trade:
        raise RuntimeError(f"pair cooldown patch incomplete: {marker}")
TRADE.write_text(trade, encoding="utf-8")

print("Qualified scan execution enabled and cooldown scoped per pair")
