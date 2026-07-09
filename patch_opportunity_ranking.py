from pathlib import Path
from datetime import datetime
import shutil
import re

ROOT = Path.cwd()
BACKUP = ROOT / f"backup_opportunity_ranking_{datetime.now().strftime('%Y%m%d_%H%M%S')}"

FILES = [
    "server/oandaEntryTiming.js",
    "server/oandaScanner.js",
    "server/v3AutoTrade.js",
    "server/ictAutoTrade.js",
    "server/oandaMetalsQualifier.js",
    "server/oandaOverextension.js",
]

HELPERS = r'''

// === OPPORTUNITY RANKING PATCH ===
export function getNYHour(date = new Date()) {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      hour12: false,
    }).format(date)
  );
  return hour === 24 ? 0 : hour;
}

export function isActiveOpportunityWindow(date = new Date()) {
  const h = getNYHour(date);
  return h >= 2 && h < 10;
}

export function isProtectedHardBlock(reason = "") {
  const r = String(reason).toLowerCase();
  return (
    r.includes("rr < 1.5") ||
    r.includes("risk reward below") ||
    r.includes("spread too high") ||
    r.includes("duplicate") ||
    r.includes("max trades") ||
    r.includes("daily loss") ||
    r.includes("missing stop") ||
    r.includes("missing take profit") ||
    r.includes("invalid broker") ||
    r.includes("credentials") ||
    r.includes("live trading disabled") ||
    r.includes("execution disabled")
  );
}

export function convertLateEntryToTradableStatus(status, reason = "", now = new Date()) {
  if (!isActiveOpportunityWindow(now)) return { status, reason };

  const s = String(status || "").toLowerCase();
  const r = String(reason || "").toLowerCase();

  if (
    s === "late_entry" ||
    r.includes("late entry") ||
    r.includes("overextended") ||
    r.includes("flow opposes") ||
    r.includes("institutional flow")
  ) {
    return {
      status: "valid_entry",
      reason: `Active-window tradable opportunity: ${reason || status}`,
      warning: true,
    };
  }

  return { status, reason };
}

export function rankOpportunity(candidate = {}) {
  const rr = Number(candidate.rr ?? candidate.riskReward ?? candidate.expectedRR ?? 0);
  const confidence = Number(candidate.confidence ?? candidate.score ?? candidate.alignScore ?? 0);
  const spreadOk = candidate.spreadOk !== false;
  const duplicate = candidate.duplicate === true || candidate.hasDuplicate === true;

  if (rr < 1.5) return { mode: "NONE", score: 0, reject: "RR < 1.5" };
  if (!spreadOk) return { mode: "NONE", score: 0, reject: "spread too high" };
  if (duplicate) return { mode: "NONE", score: 0, reject: "duplicate active trade" };

  let score = 0;
  score += Math.min(confidence, 100);
  score += Math.min(rr * 12, 40);

  if (candidate.entryStatus === "valid_entry") score += 15;
  if (candidate.entryStatus === "wait_for_retest") score += 8;
  if (candidate.macroBias && candidate.direction && String(candidate.macroBias).includes(candidate.direction)) score += 10;

  if (confidence >= 70 && rr >= 1.5) {
    return { mode: "SCALP", score, reject: null };
  }

  if (confidence >= 76 && rr >= 1.5) {
    return { mode: "SWING", score, reject: null };
  }

  return { mode: "NONE", score, reject: "confidence below opportunity threshold" };
}

export function softenActiveWindowRejects(reasons = [], now = new Date()) {
  if (!isActiveOpportunityWindow(now)) return reasons;

  return reasons.filter((reason) => {
    const r = String(reason).toLowerCase();

    if (isProtectedHardBlock(r)) return true;

    if (
      r.includes("late_entry") ||
      r.includes("late entry") ||
      r.includes("overextended") ||
      r.includes("flow opposes") ||
      r.includes("institutional flow") ||
      r.includes("missing smt") ||
      r.includes("missing fvg") ||
      r.includes("mixed ema") ||
      r.includes("liquidity proxy")
    ) {
      return false;
    }

    return true;
  });
}
// === END OPPORTUNITY RANKING PATCH ===

'''

def backup(path):
    dest = BACKUP / path.relative_to(ROOT)
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(path, dest)

def write_if_changed(path, text, original):
    if text != original:
        backup(path)
        path.write_text(text)
        print(f"patched {path}")
        return True
    return False

def ensure_helpers(text):
    if "OPPORTUNITY RANKING PATCH" not in text:
        text += "\n\n" + HELPERS
    return text

def patch_entry_timing(path):
    text = path.read_text(errors="ignore")
    original = text
    text = ensure_helpers(text)

    # Replace direct late_entry status returns with active-window conversion.
    text = re.sub(
        r"status:\s*['\"]late_entry['\"]",
        "status: isActiveOpportunityWindow(new Date()) ? 'valid_entry' : 'late_entry'",
        text
    )

    # Make flow opposition a warning during 2am-10am.
    text = re.sub(
        r"order flow opposes setup",
        "order flow opposes setup — warning only during active opportunity window",
        text,
        flags=re.I
    )

    return write_if_changed(path, text, original)

def patch_scanner(path):
    text = path.read_text(errors="ignore")
    original = text
    text = ensure_helpers(text)

    text = text.replace("const rejectionReasons = []", "let rejectionReasons = []")
    text = text.replace("const rejectReasons = []", "let rejectReasons = []")

    # Soften explicit late-entry scanner rejection.
    text = re.sub(
        r"rejectionReasons\.push\(\s*`Rejected: late entry after extended move\. \$\{overextension\.entryTimingReason\}`\s*\);",
        """
if (!isActiveOpportunityWindow(new Date())) {
  rejectionReasons.push(`Rejected: late entry after extended move. ${overextension.entryTimingReason}`);
} else {
  warnings = warnings || [];
  warnings.push(`Active-window warning: late entry/overextension softened. ${overextension.entryTimingReason}`);
}
""",
        text
    )

    # Soften institutional flow hard reject.
    text = re.sub(
        r"rejectionReasons\.push\(\s*`Institutional flow proxy points \$\{institutionalFlow\.direction\} ` \+\s*`while trade direction is \$\{direction\}.*?`\s*\);",
        """
if (!isActiveOpportunityWindow(new Date())) {
  rejectionReasons.push(
    `Institutional flow proxy points ${institutionalFlow.direction} ` +
    `while trade direction is ${direction} — order flow opposes setup`
  );
} else {
  warnings = warnings || [];
  warnings.push(`Active-window warning: institutional flow opposes ${direction}, not hard rejected`);
}
""",
        text,
        flags=re.S
    )

    # Before qualification, remove soft blockers during active window.
    if "softenActiveWindowRejects(rejectionReasons" not in text:
        text = re.sub(
            r"(qualified\s*[:=]\s*)(rejectionReasons\.length\s*===\s*0)",
            r"rejectionReasons = softenActiveWindowRejects(rejectionReasons, new Date());\n\1rejectionReasons.length === 0",
            text,
            count=1
        )

    # Convert reject mapper late_entry to warning classification in active window.
    text = text.replace(
        "if (has(/late entry after extended move/i))  return 'late_entry';",
        "if (has(/late entry after extended move/i))  return isActiveOpportunityWindow(new Date()) ? 'active_window_warning' : 'late_entry';"
    )

    return write_if_changed(path, text, original)

def patch_auto_trade(path):
    text = path.read_text(errors="ignore")
    original = text
    text = ensure_helpers(text)

    # Remove hard late_entry block inside auto-trade boolean checks.
    text = text.replace(
        "entryStatus !== 'late_entry' &&",
        "(isActiveOpportunityWindow(new Date()) || entryStatus !== 'late_entry') &&"
    )

    text = text.replace(
        "!text.includes('late_entry') &&",
        "(isActiveOpportunityWindow(new Date()) || !text.includes('late_entry')) &&"
    )

    # Soften standalone late_entry text block.
    text = re.sub(
        r"if\s*\(\s*text\.includes\(['\"]late_entry['\"]\)\s*\|\|\s*text\.includes\(['\"]overextended['\"]\)\s*\)\s*\{",
        "if (!isActiveOpportunityWindow(new Date()) && (text.includes('late_entry') || text.includes('overextended'))) {",
        text
    )

    return write_if_changed(path, text, original)

def patch_metals(path):
    text = path.read_text(errors="ignore")
    original = text
    text = ensure_helpers(text)

    text = re.sub(
        r"Rejected by metals logic: late entry / overextension",
        "Active-window metals warning: late entry / overextension",
        text
    )

    text = re.sub(
        r"if\s*\(\s*overextension\?\.(lateEntryDetected|isLateEntry)\s*\)\s*\{",
        "if (!isActiveOpportunityWindow(new Date()) && overextension?.lateEntryDetected) {",
        text
    )

    return write_if_changed(path, text, original)

patched = []

for file in FILES:
    path = ROOT / file
    if not path.exists():
        print(f"missing {file}")
        continue

    if file.endswith("oandaEntryTiming.js"):
        changed = patch_entry_timing(path)
    elif file.endswith("oandaScanner.js"):
        changed = patch_scanner(path)
    elif file.endswith("v3AutoTrade.js") or file.endswith("ictAutoTrade.js"):
        changed = patch_auto_trade(path)
    elif file.endswith("oandaMetalsQualifier.js"):
        changed = patch_metals(path)
    else:
        text = path.read_text(errors="ignore")
        original = text
        text = ensure_helpers(text)
        changed = write_if_changed(path, text, original)

    if changed:
        patched.append(file)

print("\nModified:")
for f in patched:
    print(f" - {f}")

print(f"\nBackups saved to: {BACKUP}")
