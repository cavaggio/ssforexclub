from pathlib import Path
from datetime import datetime
import shutil

ROOT = Path.cwd()
BACKUP = ROOT / f"backup_decision_gate_{datetime.now().strftime('%Y%m%d_%H%M%S')}"

TARGETS = [
    ROOT / "server/oandaTrade.js",
    ROOT / "server/ictExecution.js",
]

IMPORT = "import { evaluateTradeCandidate } from './tradeDecisionEngine.js';\n"

MARKER = "// June 23 restored centralized decision gate"

GATE = r'''
    // June 23 restored centralized decision gate
    const june23Decision = evaluateTradeCandidate({
      confidence: Number(signal?.confidence ?? analysis?.confidence ?? confidence ?? 0),
      rr: Number(signal?.rr ?? signal?.riskReward ?? signal?.expectedRR ?? riskReward ?? expectedRR ?? 0),

      structureConfirmed: Boolean(
        signal?.structureConfirmed ??
        analysis?.structureConfirmed ??
        signal?.mss ??
        signal?.bos ??
        analysis?.mss ??
        analysis?.bos
      ),

      liquidityConfirmed: Boolean(
        signal?.liquidityConfirmed ??
        analysis?.liquidityConfirmed ??
        signal?.liquiditySweep ??
        signal?.liquidityGrab ??
        analysis?.liquiditySweep ??
        analysis?.liquidityGrab
      ),

      expectedRRConfirmed: Boolean(
        signal?.expectedRRConfirmed ??
        analysis?.expectedRRConfirmed ??
        signal?.expectedRR ??
        analysis?.expectedRR ??
        riskReward ??
        expectedRR
      ),

      premiumDiscountConfirmed: Boolean(
        signal?.premiumDiscountConfirmed ??
        analysis?.premiumDiscountConfirmed ??
        signal?.premiumDiscount ??
        signal?.premiumDiscountZone ??
        signal?.ote ??
        analysis?.premiumDiscount ??
        analysis?.premiumDiscountZone ??
        analysis?.ote
      ),

      regimeAligned: signal?.regimeAligned ?? analysis?.regimeAligned,
      liquidityIntentStrong: signal?.liquidityIntentStrong ?? analysis?.liquidityIntentStrong,
      calibrationPositive: signal?.calibrationPositive ?? analysis?.calibrationPositive,
      smtDivergence: signal?.smtDivergence ?? analysis?.smtDivergence,
      sessionNarrativeAligned: signal?.sessionNarrativeAligned ?? analysis?.sessionNarrativeAligned,
    }, {
      startingDailyBalance: startingDailyBalance ?? account?.startingDailyBalance ?? balanceUSD,
      currentBalance: currentBalance ?? account?.balance ?? balanceUSD,
    });

    if (!june23Decision.allowed) {
      return {
        executed: false,
        skipped: true,
        reason: june23Decision.reason,
        confidence: june23Decision.confidence,
        rr: june23Decision.rr,
      };
    }

'''

ORDER_PATTERNS = [
    "await client.post(`/v3/accounts/${accountId}/orders`",
    "await oandaPost(`/v3/accounts/${accountId}/orders`",
]

def backup(path):
    dest = BACKUP / path.relative_to(ROOT)
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(path, dest)

def add_import(text):
    if "tradeDecisionEngine.js" in text:
        return text
    lines = text.splitlines(True)
    last_import = -1
    for i, line in enumerate(lines):
        if line.strip().startswith("import "):
            last_import = i
    if last_import >= 0:
        lines.insert(last_import + 1, IMPORT)
        return "".join(lines)
    return IMPORT + text

def patch(path):
    text = path.read_text()

    if MARKER in text:
        print(f"Already patched: {path}")
        return

    text = add_import(text)

    insert_at = None
    for pattern in ORDER_PATTERNS:
        idx = text.find(pattern)
        if idx != -1:
            insert_at = idx
            break

    if insert_at is None:
        print(f"No OANDA order placement found in {path}")
        return

    line_start = text.rfind("\n", 0, insert_at) + 1
    text = text[:line_start] + GATE + text[line_start:]
    path.write_text(text)
    print(f"Patched: {path}")

BACKUP.mkdir(exist_ok=True)

for target in TARGETS:
    if target.exists():
        backup(target)
        patch(target)
    else:
        print(f"Missing: {target}")

print(f"Backups saved to {BACKUP}")
