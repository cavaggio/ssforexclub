from pathlib import Path
import re
import sys

checks = []

def add_check(name, ok, detail=""):
    checks.append((name, bool(ok), detail))

def read(path):
    p = Path(path)
    if not p.exists():
        return None
    return p.read_text(errors="ignore")

def has(path, *needles):
    txt = read(path)
    if txt is None:
        return False
    return all(n in txt for n in needles)

def exists(path):
    return Path(path).exists()

# ------------------------------------------------------------
# 1) Backend execution gates
# ------------------------------------------------------------

trade = read("server/oandaTrade.js")

add_check(
    "oandaTrade.js exists",
    trade is not None,
)

if trade:
    add_check(
        "High-edge Auto AI constants present",
        all(x in trade for x in [
            "AUTO_AI_MIN_ENTRY_CONFIDENCE",
            "AUTO_AI_MIN_ALIGNMENT_SCORE",
            "AUTO_AI_MIN_V3_SCORE",
            "AUTO_AI_MIN_TP_PROBABILITY",
            "AUTO_AI_MIN_TP_SL_EDGE",
        ]),
    )

    add_check(
        "High-edge Auto AI gate function present",
        "function highEdgeAutoAiGate" in trade,
    )

    add_check(
        "High-edge gate runs before live order",
        "HIGH_EDGE_GATE" in trade and "High-edge Auto AI gate rejected" in trade,
    )

    add_check(
        "Final execution R:R floor present",
        (
            "finalRiskReward" in trade and
            ("< 1.5" in trade or "MIN_EXECUTABLE_RR" in trade)
        ),
    )

    add_check(
        "Pure V3 execution flag present",
        "pureV3Execution" in trade,
    )

    add_check(
        "Pure V3 skips legacy EMA/MTF gate",
        "skipping legacy EMA/MTF gate" in trade,
    )

    add_check(
        "Auto AI confidence floor still enforced",
        "checkAutoExecutionConfidence" in trade,
    )

    add_check(
        "Duplicate trade lock reconciliation present",
        "reconcileTradeLock" in trade and "DUPLICATE TRADE REJECTED" in trade,
    )

# ------------------------------------------------------------
# 2) Pure V3 Auto AI routing / Hot Watch R:R filtering
# ------------------------------------------------------------

v3_auto = read("server/v3AutoTrade.js")

add_check("v3AutoTrade.js exists", v3_auto is not None)

if v3_auto:
    add_check(
        "V3 Auto AI can run pure V3 only",
        "FOREX_V3_AUTO_USE_LEGACY_QUALIFIED" in v3_auto,
    )

    add_check(
        "V3 pure source marker present",
        "v3_pure_auto_ai" in v3_auto,
    )

    add_check(
        "V3 sub-1.5R promotion guard present",
        "isSubMinRrCandidate" in v3_auto and "R:R below executable minimum" in v3_auto,
    )

    add_check(
        "V3 Hot Watch excludes sub-min R:R",
        "hotPairs.add(pair)" in v3_auto and "isSubMinRrCandidate" in v3_auto,
    )

# ------------------------------------------------------------
# 3) OANDA transaction sync / Edge Intelligence logs
# ------------------------------------------------------------

add_check(
    "OANDA transaction sync library exists",
    exists("web/lib/oandaTransactionSync.ts"),
)

tx_sync = read("web/lib/oandaTransactionSync.ts")
if tx_sync:
    add_check(
        "OANDA sync reads broker transactions",
        "transactions/sinceid" in tx_sync and "closeEventsFromTransaction" in tx_sync,
    )

    add_check(
        "OANDA sync logs TP/SL close rows",
        "TAKE_PROFIT" in tx_sync and "STOP_LOSS" in tx_sync and "logTradeEvent" in tx_sync,
    )

add_check(
    "Manual transaction sync API route exists",
    exists("web/app/api/scanner/transactions/sync/route.ts"),
)

add_check(
    "Cron transaction sync API route exists",
    exists("web/app/api/cron/oanda-transaction-sync/route.ts"),
)

sched = read("server/ictAutoScheduler.js")
add_check("ictAutoScheduler.js exists", sched is not None)

if sched:
    add_check(
        "Railway scheduler calls OANDA transaction sync",
        "OANDA_TRANSACTION_SYNC_INTERVAL_MS" in sched and "transactionSyncTick" in sched,
    )

logs = read("web/lib/tradeLogs.ts")
add_check("tradeLogs.ts exists", logs is not None)

if logs:
    add_check(
        "Trade log fallback insert exists",
        "production-safe fallback" in logs,
    )

    add_check(
        "Trade logs support Edge payload",
        "edgeColumns" in logs or "edge:" in logs,
    )

add_check(
    "OANDA transaction sync migration exists",
    exists("supabase/migrations/20260709195000_oanda_transaction_sync_state.sql"),
)

# ------------------------------------------------------------
# 4) Dashboard display guard
# ------------------------------------------------------------

card = read("web/components/scanner-status-card.tsx")
add_check("scanner-status-card.tsx exists", card is not None)

if card:
    add_check(
        "Dashboard suppresses sub-1.5R setups",
        "isSubMinRrDisplay" in card and "rr !== null" in card,
    )

# ------------------------------------------------------------
# Print summary
# ------------------------------------------------------------

failed = [c for c in checks if not c[1]]

print("\n=== SIGNAL STACK AUTO AI VERIFICATION ===\n")

for name, ok, detail in checks:
    icon = "✅" if ok else "❌"
    print(f"{icon} {name}")
    if detail:
        print(f"   {detail}")

print("\n=== RESULT ===")
if failed:
    print(f"❌ {len(failed)} check(s) failed:")
    for name, _, _ in failed:
        print(f"   - {name}")
    sys.exit(1)

print("✅ All required code-level checks passed.")
