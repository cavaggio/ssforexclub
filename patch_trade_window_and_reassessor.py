from pathlib import Path
from datetime import datetime
import shutil
import sys

ROOT = Path.cwd()
STAMP = datetime.now().strftime("%Y%m%d_%H%M%S")
BACKUP_DIR = ROOT / f"backup_window_reassessor_{STAMP}"
BACKUP_DIR.mkdir(exist_ok=True)

FILES = [
    "server/ictAutoScheduler.js",
    "web/app/api/cron/auto-ai-trading/route.ts",
    "server/v3AutoTrade.js",
    "server/oandaScanner.js",
    "server/tradeDecisionEngine.js",
    "server/oandaTrade.js",
    "server/oandaActiveTradeReassessor.js",
]

def backup(path: Path):
    dest = BACKUP_DIR / path.relative_to(ROOT)
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(path, dest)

def patch(path_str, replacements):
    path = ROOT / path_str
    if not path.exists():
        print(f"❌ Missing file: {path_str}")
        sys.exit(1)

    backup(path)
    text = path.read_text()
    original = text

    for old, new in replacements:
        if old not in text:
            print(f"⚠️ Pattern not found in {path_str}: {old[:80]!r}")
        text = text.replace(old, new)

    if text != original:
        path.write_text(text)
        print(f"✅ Patched {path_str}")
    else:
        print(f"⚠️ No changes made to {path_str}")

# 1) Railway scheduler: 02:15–14:00 ET
patch("server/ictAutoScheduler.js", [
    ("Only fires on NY\n * weekdays between 02:15 and 10:00 ET", "Only fires on NY\n * weekdays between 02:15 and 14:00 ET"),
    ("export const AUTO_AI_WINDOW = { startMin: 2 * 60 + 15, endMin: 10 * 60 }; // 02:15–10:00 ET",
     "export const AUTO_AI_WINDOW = { startMin: 2 * 60 + 15, endMin: 14 * 60 }; // 02:15–14:00 ET"),
    ("`(NY weekday 02:15–10:00 ET; full=${fullScanMs}ms near=${nearRecheckMs}ms hot=${hotWatchMs}ms)`",
     "`(NY weekday 02:15–14:00 ET; full=${fullScanMs}ms near=${nearRecheckMs}ms hot=${hotWatchMs}ms)`"),
])

# 2) Vercel cron route: 02:15–14:00 ET
patch("web/app/api/cron/auto-ai-trading/route.ts", [
    ("NY weekday 02:15–10:00 ET window", "NY weekday 02:15–14:00 ET window"),
    ("// NY weekday 02:15–10:00 ET", "// NY weekday 02:15–14:00 ET"),
    ("return mins >= 135 && mins < 600; // 02:15–10:00 ET",
     "return mins >= 135 && mins < 840; // 02:15–14:00 ET"),
])

# 3) Active opportunity windows: 2–14 ET
for file in [
    "server/v3AutoTrade.js",
    "server/oandaScanner.js",
    "server/tradeDecisionEngine.js",
    "server/oandaTrade.js",
]:
    patch(file, [
        ("return h >= 2 && h < 10;", "return h >= 2 && h < 14;"),
        ("return hour >= 2 && hour < 10;", "return hour >= 2 && hour < 14;"),
    ])

# 4) Reassessor: 30 min → 15 min and log text
patch("server/oandaActiveTradeReassessor.js", [
    ("startReassessmentScheduler({intervalMs}) — env-guarded 30-min loop",
     "startReassessmentScheduler({intervalMs}) — env-guarded 15-min loop"),
    ("const REASSESSMENT_INTERVAL_MS = 30 * 60 * 1000;   // 30 min — Part 10",
     "const REASSESSMENT_INTERVAL_MS = 15 * 60 * 1000;   // 15 min — active management cadence"),
    ("// PART 10 — 30-MINUTE SCHEDULER", "// PART 10 — 15-MINUTE SCHEDULER"),
    ("* Start the 30-min reassessment loop.", "* Start the 15-min reassessment loop."),
    ("console.log(`[REASSESSOR] Starting 30-min active-trade reassessment scheduler (interval ${intervalMs}ms)`);",
     "console.log(`[REASSESSOR] Starting 15-min active-trade reassessment scheduler (interval ${intervalMs}ms)`);"),
])

print(f"\\nBackups saved in: {BACKUP_DIR}")
print("\\nNext run:")
print("  node --check server/ictAutoScheduler.js")
print("  node --check web/app/api/cron/auto-ai-trading/route.ts")
print("  node --check server/v3AutoTrade.js")
print("  node --check server/oandaScanner.js")
print("  node --check server/tradeDecisionEngine.js")
print("  node --check server/oandaTrade.js")
print("  node --check server/oandaActiveTradeReassessor.js")
