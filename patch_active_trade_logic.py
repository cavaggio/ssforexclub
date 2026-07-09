from pathlib import Path
from datetime import datetime
import shutil
import re

ROOT = Path.cwd()
BACKUP = ROOT / f"backup_active_trade_logic_{datetime.now().strftime('%Y%m%d_%H%M%S')}"

FILES = [
    "server/tradeDecisionEngine.js",
    "server/ictExecution.js",
    "server/oandaTrade.js",
    "server/ictAutoScheduler.js",
]

HELPERS = r'''
// === ACTIVE TRADE LOGIC PATCH ===
export function getNewYorkHour(date = new Date()) {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      hour12: false,
    }).format(date)
  );
  return hour === 24 ? 0 : hour;
}

export function isPrimaryTradeWindow(date = new Date()) {
  const hour = getNewYorkHour(date);
  return hour >= 2 && hour < 10;
}

export function isTrueHardReject(reason = "") {
  const r = String(reason).toLowerCase();
  return (
    r.includes("rr") && r.includes("1.5") ||
    r.includes("risk reward") && r.includes("below") ||
    r.includes("max daily loss") ||
    r.includes("daily loss") ||
    r.includes("max trades") ||
    r.includes("duplicate") ||
    r.includes("spread too high") ||
    r.includes("invalid broker") ||
    r.includes("credentials") ||
    r.includes("missing stop") ||
    r.includes("missing take profit") ||
    r.includes("live trading disabled") ||
    r.includes("execution disabled")
  );
}

export function softenRejectReasons(reasons = [], now = new Date()) {
  if (!isPrimaryTradeWindow(now)) return reasons;

  return reasons.filter((reason) => {
    const r = String(reason).toLowerCase();

    if (isTrueHardReject(r)) return true;

    if (
      r.includes("late_entry") ||
      r.includes("late entry") ||
      r.includes("flow opposes") ||
      r.includes("institutional flow") ||
      r.includes("missing smt") ||
      r.includes("missing fvg") ||
      r.includes("mixed ema") ||
      r.includes("emaalignment=mixed") ||
      r.includes("single opposing liquidity") ||
      r.includes("liquidity proxy")
    ) {
      return false;
    }

    return true;
  });
}

export function pickTradeMode(candidate = {}) {
  const rr = Number(candidate.rr ?? candidate.riskReward ?? candidate.expectedRR ?? 0);
  const confidence = Number(candidate.confidence ?? candidate.score ?? 0);

  if (rr >= 1.5 && confidence >= 70) return "SCALP";
  if (rr >= 1.5 && confidence >= 76) return "SWING";
  return "NONE";
}
// === END ACTIVE TRADE LOGIC PATCH ===
'''

def backup(path):
    dest = BACKUP / path.relative_to(ROOT)
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(path, dest)

def patch_file(path):
    text = path.read_text(errors="ignore")
    original = text

    if "ACTIVE TRADE LOGIC PATCH" not in text:
        text += "\n\n" + HELPERS + "\n"

    text = text.replace("const rejectReasons = []", "let rejectReasons = []")
    text = text.replace("const reasons = []", "let reasons = []")

    text = re.sub(
        r"minRR\s*[:=]\s*[0-9.]+",
        "minRR: 1.5",
        text
    )

    text = re.sub(
        r"minConfidence\s*[:=]\s*([89][0-9]|100)",
        "minConfidence: 70",
        text
    )

    patterns = [
        r'([^;\n]*rejectReasons\.push\([^)]*late[^)]*\);)',
        r'([^;\n]*rejectReasons\.push\([^)]*FLOW OPPOSES[^)]*\);)',
        r'([^;\n]*rejectReasons\.push\([^)]*flow opposes[^)]*\);)',
        r'([^;\n]*rejectReasons\.push\([^)]*institutional flow[^)]*\);)',
        r'([^;\n]*rejectReasons\.push\([^)]*SMT[^)]*\);)',
        r'([^;\n]*rejectReasons\.push\([^)]*FVG[^)]*\);)',
        r'([^;\n]*rejectReasons\.push\([^)]*EMA[^)]*\);)',
    ]

    for pat in patterns:
        text = re.sub(
            pat,
            r'''
if (!isPrimaryTradeWindow(new Date())) {
  \1
} else {
  warnings = warnings || [];
  warnings.push("Soft warning only during 2am-10am NY active window");
}
''',
            text,
            flags=re.IGNORECASE
        )

    if "softenRejectReasons(rejectReasons" not in text:
        text = re.sub(
            r"(const\s+qualified\s*=\s*)rejectReasons\.length\s*===\s*0",
            r"rejectReasons = softenRejectReasons(rejectReasons, new Date());\nconst tradeMode = pickTradeMode(candidate ?? signal ?? setup ?? {});\n\1rejectReasons.length === 0",
            text,
            count=1
        )

    if "[ACTIVE_TRADE_LOGIC]" not in text and "rejectReasons" in text:
        text += r'''

function logActiveTradeLogic(payload = {}) {
  try {
    console.log("[ACTIVE_TRADE_LOGIC]", JSON.stringify({
      primaryWindow: isPrimaryTradeWindow(new Date()),
      nyHour: getNewYorkHour(new Date()),
      pair: payload.pair,
      direction: payload.direction,
      rr: payload.rr ?? payload.expectedRR,
      confidence: payload.confidence,
      tradeMode: payload.tradeMode,
      rejectReasons: payload.rejectReasons,
      warnings: payload.warnings,
    }));
  } catch {}
}
'''

    if text != original:
        backup(path)
        path.write_text(text)
        return True

    return False

changed = []

for file in FILES:
    path = ROOT / file
    if path.exists():
        if patch_file(path):
            changed.append(file)

print("Modified files:")
for file in changed:
    print(f" - {file}")

print(f"\nBackups saved to: {BACKUP}")
