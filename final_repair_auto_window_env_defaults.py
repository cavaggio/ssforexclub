from pathlib import Path
from datetime import datetime
import shutil
import re
import sys

ROOT = Path.cwd()
STAMP = datetime.now().strftime("%Y%m%d_%H%M%S")
BACKUP = ROOT / f"backup_final_auto_window_{STAMP}"
BACKUP.mkdir(exist_ok=True)

def patch_file(rel, replacements):
    path = ROOT / rel
    if not path.exists():
        print(f"❌ Missing {rel}")
        sys.exit(1)

    dest = BACKUP / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(path, dest)

    text = path.read_text()
    original = text

    for old, new in replacements:
        if old not in text:
            print(f"⚠️ Pattern not found in {rel}: {old[:90]!r}")
        text = text.replace(old, new)

    if text != original:
        path.write_text(text)
        print(f"✅ Patched {rel}")
    else:
        print(f"⚠️ No changes made to {rel}")

# 1) Fix actual Railway scheduler window to 02:15–14:00 ET.
patch_file("server/ictAutoScheduler.js", [
    (
        "export const AUTO_AI_WINDOW = { startMin: 2 * 60 + 15, endMin: 10 * 60 }; // 02:15–11:00 ET",
        "export const AUTO_AI_WINDOW = { startMin: 2 * 60 + 15, endMin: 14 * 60 }; // 02:15–14:00 ET",
    ),
    (
        "/** True only on a NY weekday within 02:15–11:00 ET. */",
        "/** True only on a NY weekday within 02:15–14:00 ET. */",
    ),
    (
        "(NY weekday 02:15–11:00 ET; full=${fullScanMs}ms near=${nearRecheckMs}ms hot=${hotWatchMs}ms)",
        "(NY weekday 02:15–14:00 ET; full=${fullScanMs}ms near=${nearRecheckMs}ms hot=${hotWatchMs}ms)",
    ),
])

# 2) Update scheduler tests if they still expect 10/11 a.m.
test = ROOT / "server/ictAutoScheduler.test.js"
if test.exists():
    shutil.copy2(test, BACKUP / "server/ictAutoScheduler.test.js")
    t = test.read_text()
    original = t
    t = t.replace("10:00", "14:00")
    t = t.replace("11:00", "14:00")
    t = t.replace("T14:01:00Z", "T18:01:00Z")
    t = t.replace("T15:00:00Z", "T19:00:00Z")
    # Common UTC equivalents during Eastern Daylight Time:
    # 02:15 ET = 06:15Z, 14:00 ET = 18:00Z.
    if t != original:
        test.write_text(t)
        print("✅ Patched server/ictAutoScheduler.test.js")
    else:
        print("ℹ️ No scheduler test update needed")

# 3) Commit the risk manager default so Auto AI does not silently default to 90.
patch_file("server/riskManager.js", [
    (
        "autoExecutionMinConfidence: parseFloat(process.env.RISK_AUTO_EXECUTION_MIN_CONFIDENCE || '90'),",
        "autoExecutionMinConfidence: parseFloat(process.env.RISK_AUTO_EXECUTION_MIN_CONFIDENCE || process.env.FOREX_MIN_CONFIDENCE || '76'),",
    ),
])

print(f"\nBackups saved in: {BACKUP}")
