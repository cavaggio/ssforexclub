from pathlib import Path
from datetime import datetime
import shutil

ROOT = Path.cwd()
BACKUP = ROOT / f"backup_v3_active_window_promotion_{datetime.now().strftime('%Y%m%d_%H%M%S')}"

files = [
    "server/oandaScanner.js",
    "server/v3AutoTrade.js",
    "server/autoAiRouter.js",
    "server/ictAutoScheduler.js",
]

for file in files:
    p = ROOT / file
    if not p.exists():
        print("missing", file)
        continue

    s = p.read_text()
    original = s

    # Make common V3 soft blockers non-fatal during active window.
    s = s.replace(
        "macro bias is ranging — no directional trade qualified",
        "active-window warning: macro bias ranging, scalp/swing fallback allowed"
    )

    s = s.replace(
        "momentum layer produced no execution signal",
        "active-window warning: weak momentum signal, scalp/swing fallback allowed"
    )

    s = s.replace(
        "structural confidence 15 < min 30",
        "active-window warning: structural confidence below preferred floor"
    )

    s = s.replace(
        "structural confidence 0 < min 30",
        "active-window warning: structural confidence below preferred floor"
    )

    s = s.replace(
        "institutional flow proxy points bearish (top: liquidity_sweep) — opposes long trade",
        "active-window warning: institutional flow opposes, not hard rejected"
    )

    s = s.replace(
        "institutional flow proxy points bullish (top: liquidity_sweep) — opposes short trade",
        "active-window warning: institutional flow opposes, not hard rejected"
    )

    # Lower internal structural floor if directly coded.
    s = s.replace("minStructuralConfidence: 30", "minStructuralConfidence: 0")
    s = s.replace("MIN_STRUCTURAL_CONFIDENCE = 30", "MIN_STRUCTURAL_CONFIDENCE = 0")
    s = s.replace("structuralConfidence < 30", "false && structuralConfidence < 30")

    # Make V3 promotion threshold match active scalp behavior.
    s = s.replace("FOREX_V3_PROMOTE_MIN_CONFIDENCE || 85", "FOREX_V3_PROMOTE_MIN_CONFIDENCE || 70")
    s = s.replace("Number(process.env.FOREX_V3_PROMOTE_MIN_CONFIDENCE ?? 85)", "Number(process.env.FOREX_V3_PROMOTE_MIN_CONFIDENCE ?? 70)")

    if s != original:
        dest = BACKUP / file
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(p, dest)
        p.write_text(s)
        print("patched", file)

print("Backups:", BACKUP)
