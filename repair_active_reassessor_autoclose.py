from pathlib import Path
from datetime import datetime
import shutil
import re
import sys

ROOT = Path.cwd()
FILE = ROOT / "server/oandaActiveTradeReassessor.js"
STAMP = datetime.now().strftime("%Y%m%d_%H%M%S")
BACKUP = ROOT / f"backup_repair_active_reassessor_{STAMP}"

if not FILE.exists():
    print("❌ Missing server/oandaActiveTradeReassessor.js")
    sys.exit(1)

BACKUP.mkdir(exist_ok=True)
shutil.copy2(FILE, BACKUP / "oandaActiveTradeReassessor.js")

text = FILE.read_text()

def remove_function_everywhere(src, name):
    """
    Remove every function declaration named `name`, even if it was accidentally
    pasted inside another function/object.
    """
    pattern = re.compile(rf"\n?function\s+{re.escape(name)}\s*\([^)]*\)\s*\{{")
    while True:
        m = pattern.search(src)
        if not m:
            return src

        start = m.start()
        brace_start = src.find("{", m.start())
        if brace_start == -1:
            print(f"❌ Could not find opening brace for {name}")
            sys.exit(1)

        depth = 0
        i = brace_start
        in_str = None
        escape = False

        while i < len(src):
            ch = src[i]

            if in_str:
                if escape:
                    escape = False
                elif ch == "\\":
                    escape = True
                elif ch == in_str:
                    in_str = None
            else:
                if ch in ("'", '"', "`"):
                    in_str = ch
                elif ch == "{":
                    depth += 1
                elif ch == "}":
                    depth -= 1
                    if depth == 0:
                        end = i + 1
                        while end < len(src) and src[end] in " \t\r\n":
                            end += 1
                        src = src[:start] + "\n" + src[end:]
                        break
            i += 1
        else:
            print(f"❌ Could not find closing brace for {name}")
            sys.exit(1)

# 1) Remove misplaced helper functions wherever they were pasted.
for fn in ["nyMinutesSinceMidnight", "isPostEntryManagementWindow", "shouldAutoCloseTrade"]:
    text = remove_function_everywhere(text, fn)

# 2) Add close helper import if missing.
if "closeBrokerTrade" not in text:
    marker = "import { getEnvironment, isLiveExecutionExplicitlyAllowed } from './oandaClient.js';"
    replacement = marker + "\nimport { closeBrokerTrade } from './oandaTrade.js';"
    if marker not in text:
        print("❌ Could not find oandaClient import marker.")
        sys.exit(1)
    text = text.replace(marker, replacement)

# 3) Make reassessment interval 15 minutes and env-overridable.
text = re.sub(
    r"const REASSESSMENT_INTERVAL_MS\s*=\s*[^;]+;\s*//[^\n]*",
    "const REASSESSMENT_INTERVAL_MS = Number(process.env.ACTIVE_TRADE_REASSESS_INTERVAL_MS || 15 * 60 * 1000); // 15 min — active management cadence",
    text,
)

text = text.replace("30-min active-trade reassessment scheduler", "15-min active-trade reassessment scheduler")
text = text.replace("30-MINUTE SCHEDULER", "15-MINUTE SCHEDULER")
text = text.replace("Start the 30-min reassessment loop", "Start the 15-min reassessment loop")
text = text.replace("env-guarded 30-min loop", "env-guarded 15-min loop")

# 4) Insert helper functions at module scope after _scheduler.
helper_block = r"""
function nyMinutesSinceMidnight(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now);

  const hour = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10) % 24;
  const minute = parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10);
  return hour * 60 + minute;
}

function isPostEntryManagementWindow(now = new Date()) {
  return nyMinutesSinceMidnight(now) >= 14 * 60;
}

function shouldAutoCloseTrade(plan = {}) {
  const action = String(plan.recommendedAction || '').toUpperCase();
  const lifecycleAction = String(plan.lifecycleRecommendation?.action || '').toUpperCase();
  const momentumStatus = String(plan.momentumStatus || '').toLowerCase();

  if (plan.invalidationDetected === true) return true;

  if (
    plan.trendWeakeningDetected === true &&
    String(plan.trendWeakeningSeverity || '').toLowerCase() === 'high'
  ) {
    return true;
  }

  if (action === 'EXIT_INVALIDATED' || action === 'EXIT_REVIEW') return true;
  if (lifecycleAction.includes('EXIT') || lifecycleAction.includes('CLOSE')) return true;

  if (
    momentumStatus.includes('reversal') ||
    momentumStatus.includes('reversed') ||
    momentumStatus.includes('decay') ||
    momentumStatus.includes('slowing')
  ) {
    return true;
  }

  return false;
}
"""

if "function shouldAutoCloseTrade" not in text:
    marker = "let _scheduler = null;"
    if marker not in text:
        print("❌ Could not find _scheduler marker.")
        sys.exit(1)
    text = text.replace(marker, marker + "\n" + helper_block, 1)

# 5) Add auto-close execution block after trades are built.
auto_close_block = r"""
  const autoCloseResults = [];

  if (AUTO_CLOSE_ENABLED && isPostEntryManagementWindow(new Date())) {
    if (!client) {
      console.warn('[REASSESSOR_AUTO_CLOSE] skipped — missing per-request client');
    } else {
      for (const plan of trades) {
        if (!plan || plan.error) continue;
        if (!shouldAutoCloseTrade(plan)) continue;

        console.warn(
          `[REASSESSOR_AUTO_CLOSE] closing tradeId=${plan.tradeId} instrument=${plan.instrument} ` +
          `action=${plan.recommendedAction} momentum=${plan.momentumStatus} ` +
          `trendWeakening=${plan.trendWeakeningDetected}/${plan.trendWeakeningSeverity} ` +
          `invalidation=${plan.invalidationDetected}/${plan.invalidationSeverity}`
        );

        const closeResult = await closeBrokerTrade({
          tradeId: plan.tradeId,
          instrument: plan.instrument,
          units: 'ALL',
          client,
        });

        plan.autoCloseAttempted = true;
        plan.autoCloseResult = closeResult;

        autoCloseResults.push({
          tradeId: plan.tradeId,
          instrument: plan.instrument,
          ok: closeResult.ok,
          message: closeResult.message,
          error: closeResult.error ?? null,
        });
      }
    }
  }

"""

if "const autoCloseResults = [];" not in text:
    marker = "\n  const recCounts = trades.reduce((acc, t) => {"
    if marker not in text:
        print("❌ Could not find recCounts marker.")
        sys.exit(1)
    text = text.replace(marker, "\n" + auto_close_block + "  const recCounts = trades.reduce((acc, t) => {", 1)

# 6) Replace meta autoCloseEnabled false with real values.
text = text.replace(
    "autoCloseEnabled: false,        // hard-coded — Part 12 safety",
    "autoCloseEnabled: AUTO_CLOSE_ENABLED,\n      autoCloseWindowActive: isPostEntryManagementWindow(new Date()),\n      autoCloseResults,"
)

# no-open-trades meta block
text = text.replace(
    "autoCloseEnabled: false,\n        notice: 'No open positions on broker account'",
    "autoCloseEnabled: AUTO_CLOSE_ENABLED,\n        autoCloseWindowActive: isPostEntryManagementWindow(new Date()),\n        autoCloseResults: [],\n        notice: 'No open positions on broker account'"
)

FILE.write_text(text)

print(f"✅ Repaired {FILE}")
print(f"Backup saved in {BACKUP}")
