from pathlib import Path
import re
import sys

def die(msg):
    print(f"❌ {msg}", file=sys.stderr)
    sys.exit(1)

# -----------------------------
# 1. Patch server/oandaTrade.js
# -----------------------------
trade = Path("server/oandaTrade.js")
if not trade.exists():
    die("server/oandaTrade.js not found")

text = trade.read_text()
orig = text

# Add pure V3 execution flag.
needle = """  const { pair, direction, score, confidence, entry, stopLoss, takeProfit, spreadPips } = signal;
  const tradeKey = `${pair}_${direction}`;
"""
repl = """  const { pair, direction, score, confidence, entry, stopLoss, takeProfit, spreadPips } = signal;
  const pureV3Execution =
    signal?.source === 'v3_pure_auto_ai' ||
    signal?.selectedLogicType === 'v3_pure' ||
    signal?.strategy === 'V3';

  const tradeKey = `${pair}_${direction}`;
"""
if "const pureV3Execution =" not in text:
    if needle not in text:
        die("Could not insert pureV3Execution flag")
    text = text.replace(needle, repl, 1)

# Make duplicate lock always verify broker, not only local memory.
old = """  if (!activeTrades.has(key)) {
    // No local lock — nothing to reconcile.
    return false;
  }

  let brokerTrades;
"""
new = """  const hadLocalLock = activeTrades.has(key);

  let brokerTrades;
"""
if old in text:
    text = text.replace(old, new, 1)

old = """  if (existsOnBroker) {
    console.log(`[BROKER POSITION VERIFIED] ${key} — broker confirms an open position`);
    return true;
  }

  console.warn(`[STALE LOCK REMOVED] ${key} — broker has no matching open position; releasing in-memory lock`);
  activeTrades.delete(key);
  return false;
"""
new = """  if (existsOnBroker) {
    activeTrades.add(key);
    console.log(`[BROKER POSITION VERIFIED] ${key} — broker confirms an open position`);
    return true;
  }

  if (hadLocalLock) {
    console.warn(`[STALE LOCK REMOVED] ${key} — broker has no matching open position; releasing in-memory lock`);
    activeTrades.delete(key);
  } else {
    console.log(`[BROKER POSITION CLEAR] ${key} — no broker position exists`);
  }

  return false;
"""
if old in text:
    text = text.replace(old, new, 1)

# Skip legacy EMA/MTF gate for pure V3 only.
old = """  // ── Guard 3.5: Multi-timeframe trend alignment ────────────────────────────
  // Defensive check — scanner already validates these, but signals can arrive
  // from direct API calls or after scanner threshold changes.
  {
"""
new = """  // ── Guard 3.5: Multi-timeframe trend alignment ────────────────────────────
  // Defensive check for legacy/waterfall signals only.
  // Pure V3 signals are gated by V3 structure/liquidity/session logic instead.
  if (!pureV3Execution) {
"""
if old in text:
    text = text.replace(old, new, 1)

# Add a visible pure V3 log before entry-quality guard.
entry_guard = """  // ── Guard 3.6: Entry-quality gates (HYBRID, configurable to STRICT) ──────
"""
if "[V3_PURE] skipping legacy entry-quality" not in text:
    text = text.replace(
        entry_guard,
        """  if (pureV3Execution) {
    console.log(`[V3_PURE] ${pair} ${direction} — skipping legacy EMA/MTF gate; V3 liquidity/structure/session owns qualification.`);
  }

""" + entry_guard,
        1,
    )

# For pure V3, skip institutional-flow/timing legacy rejection but keep news hard block.
old = """    if (
      flow?.detected &&
      flow.direction !== 'neutral' &&
      flow.direction !== tradeSign
    ) {
"""
new = """    if (
      !pureV3Execution &&
      flow?.detected &&
      flow.direction !== 'neutral' &&
      flow.direction !== tradeSign
    ) {
"""
if old in text:
    text = text.replace(old, new, 1)

old = """    if (ENTRY_TIMING_STRICT && timing?.status === 'too_early') {
"""
new = """    if (!pureV3Execution && ENTRY_TIMING_STRICT && timing?.status === 'too_early') {
"""
if old in text:
    text = text.replace(old, new, 1)

old = """    if (ENTRY_TIMING_STRICT && timing?.status === 'wait_for_retest') {
"""
new = """    if (!pureV3Execution && ENTRY_TIMING_STRICT && timing?.status === 'wait_for_retest') {
"""
if old in text:
    text = text.replace(old, new, 1)

old = """    if (timing && timing.status !== 'valid_entry') {
"""
new = """    if (!pureV3Execution && timing && timing.status !== 'valid_entry') {
"""
if old in text:
    text = text.replace(old, new, 1)

# Hard R:R floor after sizing, before units/margin.
needle = """  let units                 = sizing.signedUnits;
"""
guard = """  const finalRiskReward = Number(sizing?.riskReward ?? 0);
  if (!Number.isFinite(finalRiskReward) || finalRiskReward < 1.5) {
    return blocked(`Risk reward ${Number.isFinite(finalRiskReward) ? finalRiskReward : 'n/a'} < minimum 1.5 after execution sizing`);
  }

"""
if "finalRiskReward" not in text:
    if needle not in text:
        die("Could not insert final R:R execution guard")
    text = text.replace(needle, guard + needle, 1)

if text != orig:
    trade.with_suffix(".js.bak_v3_rr_dup").write_text(orig)
    trade.write_text(text)
    print("✅ Patched server/oandaTrade.js")
else:
    print("⚠️ No oandaTrade.js changes")


# -------------------------------
# 2. Patch server/v3AutoTrade.js
# -------------------------------
v3 = Path("server/v3AutoTrade.js")
if not v3.exists():
    die("server/v3AutoTrade.js not found")

text = v3.read_text()
orig = text

# Use V3 candidates from both qualified and rejected scan output, but only execute V3-promoted signals.
old = """  const rejected = Array.isArray(scan?.rejected) ? scan.rejected : [];
"""
new = """  const rejected = [
    ...(Array.isArray(scan?.qualified) ? scan.qualified : []),
    ...(Array.isArray(scan?.rejected) ? scan.rejected : []),
  ];
"""
if old in text:
    text = text.replace(old, new, 1)

old = """  const legacyQualified = Array.isArray(scan?.qualified) ? scan.qualified : [];
  const promoted = safeV3Promotions(scan, log);
  const qualified = [...legacyQualified, ...promoted];
  const watchState = buildV3WatchState(scan, qualified);
"""
new = """  const legacyQualified = Array.isArray(scan?.qualified) ? scan.qualified : [];

  const promoted = safeV3Promotions(scan, log).map((sig) => ({
    ...sig,
    source: 'v3_pure_auto_ai',
    strategy: 'V3',
    selectedLogicType: 'v3_pure',
  }));

  const useLegacyQualified = envOn(process.env.FOREX_V3_AUTO_USE_LEGACY_QUALIFIED, false);
  const qualified = useLegacyQualified ? [...legacyQualified, ...promoted] : promoted;

  if (!useLegacyQualified && legacyQualified.length) {
    log(`pure-v3 mode ignored legacyQualified=${legacyQualified.length}; set FOREX_V3_AUTO_USE_LEGACY_QUALIFIED=true only for hybrid testing`);
  }

  const watchState = buildV3WatchState(scan, qualified);
"""
if old in text:
    text = text.replace(old, new, 1)

old = """      executed.push({ pair: sig.pair, direction: sig.direction, tradeId: res.tradeId });
"""
new = """      executed.push({
        pair: sig.pair,
        direction: sig.direction,
        tradeId: res.tradeId,
        fillPrice: res.fillPrice,
        units: res.units,
        stopLoss: res.sizing?.stopLoss ?? sig.stopLoss,
        takeProfit: res.sizing?.takeProfit ?? sig.takeProfit,
        confidence: sig.confidence,
        expectedRR: sig.expectedRR ?? sig.rr,
        source: sig.source,
        strategy: sig.strategy ?? 'V3',
        signal: sig,
      });
"""
if old in text:
    text = text.replace(old, new, 1)

if text != orig:
    v3.with_suffix(".js.bak_pure_v3").write_text(orig)
    v3.write_text(text)
    print("✅ Patched server/v3AutoTrade.js")
else:
    print("⚠️ No v3AutoTrade.js changes")


# ---------------------------------------------
# 3. Patch web cron route to log Auto AI opens
# ---------------------------------------------
cron = Path("web/app/api/cron/auto-ai-trading/route.ts")
if not cron.exists():
    die("web/app/api/cron/auto-ai-trading/route.ts not found")

text = cron.read_text()
orig = text

text = text.replace(
    "import { listTradeLogsForUser } from '@/lib/tradeLogs';",
    "import { listTradeLogsForUser, logTradeEvent } from '@/lib/tradeLogs';",
)

if "edgeSnapshotFromSignal" not in text:
    text = text.replace(
        "import { callInternalEndpoint } from '@/lib/scannerProxy';",
        "import { callInternalEndpoint } from '@/lib/scannerProxy';\nimport { edgeSnapshotFromSignal } from '@/lib/edgeSnapshot';",
    )

marker = """      const q = autoData?.qualified ?? 0, e = autoData?.executed?.length ?? 0, s = autoData?.skipped?.length ?? 0;
      totalQualified += q; totalExecuted += e; totalSkipped += s; totalRecs += recs;
"""
insert = """      const q = autoData?.qualified ?? 0, e = autoData?.executed?.length ?? 0, s = autoData?.skipped?.length ?? 0;
      totalQualified += q; totalExecuted += e; totalSkipped += s; totalRecs += recs;

      for (const executed of (autoData?.executed ?? []) as Array<Record<string, unknown>>) {
        const sig = (executed.signal && typeof executed.signal === 'object')
          ? executed.signal as Record<string, unknown>
          : executed;

        await logTradeEvent({
          userId,
          broker: (resolved.activeBroker ?? 'oanda') as 'oanda',
          brokerAccountId: creds.accountId,
          environment: resolved.activeEnvironment as 'practice' | 'live' | 'paper',
          eventType: 'opened',
          instrument: typeof executed.pair === 'string' ? executed.pair : null,
          tradeId: typeof executed.tradeId === 'string' ? executed.tradeId : null,
          brokerOrderId: typeof executed.tradeId === 'string' ? executed.tradeId : null,
          side: executed.direction === 'long' || executed.direction === 'short' ? executed.direction : null,
          units: typeof executed.units === 'number' ? Math.abs(executed.units) : null,
          entryPrice: typeof executed.fillPrice === 'number' ? executed.fillPrice : null,
          sl: typeof executed.stopLoss === 'number' ? executed.stopLoss : null,
          tp: typeof executed.takeProfit === 'number' ? executed.takeProfit : null,
          confidence: typeof executed.confidence === 'number' ? executed.confidence : null,
          recommendation: typeof executed.expectedRR === 'number' ? `RR ${executed.expectedRR}` : 'V3_AUTO',
          reason: `Auto AI ${engine.toUpperCase()} opened trade during run ${runId}`,
          rawPayload: { runId, scanMode, engine, executed },
          edge: edgeSnapshotFromSignal(sig),
        });
      }
"""
if marker in text and "Auto AI ${engine.toUpperCase()} opened trade" not in text:
    text = text.replace(marker, insert, 1)

if text != orig:
    cron.with_suffix(".ts.bak_auto_log").write_text(orig)
    cron.write_text(text)
    print("✅ Patched web cron Auto AI open logging")
else:
    print("⚠️ No cron route changes")

print("\\nNext checks:")
print("node --check server/oandaTrade.js")
print("node --check server/v3AutoTrade.js")
print("npm run build")
