from pathlib import Path
from datetime import datetime
import shutil
import re

ROOT = Path.cwd()
SERVER = ROOT / "server"
BACKUP = ROOT / f"backup_soft_filter_scoring_{datetime.now().strftime('%Y%m%d_%H%M%S')}"

TARGETS = [
    SERVER / "v3Engine.js",
    SERVER / "ictEngine.js",
    SERVER / "v3AutoTrade.js",
    SERVER / "ictAutoTrade.js",
]

MARKER = "June 23 soft-filter scoring"

SOFT_SCORING_HELPER = r'''

// June 23 soft-filter scoring
// These filters should influence confidence, not hard-reject otherwise valid trades.
export function applyJune23SoftFilterScoring(candidate = {}) {
  let confidenceAdjustment = 0;
  const softReasons = [];

  if (candidate.regimeAligned === true) {
    confidenceAdjustment += 1;
    softReasons.push("Regime aligned: +1 confidence");
  } else if (candidate.regimeAligned === false) {
    confidenceAdjustment -= 1;
    softReasons.push("Regime not aligned: -1 confidence");
  }

  if (candidate.liquidityIntentStrong === true) {
    confidenceAdjustment += 2;
    softReasons.push("Strong liquidity intent: +2 confidence");
  } else if (candidate.liquidityIntentStrong === false) {
    confidenceAdjustment -= 1;
    softReasons.push("Weak liquidity intent: -1 confidence");
  }

  if (candidate.calibrationPositive === true) {
    confidenceAdjustment += 1;
    softReasons.push("Positive calibration: +1 confidence");
  } else if (candidate.calibrationPositive === false) {
    confidenceAdjustment -= 1;
    softReasons.push("Negative calibration: -1 confidence");
  }

  if (candidate.smtDivergence === true) {
    confidenceAdjustment += 1;
    softReasons.push("SMT divergence present: +1 confidence");
  }

  if (candidate.sessionNarrativeAligned === true) {
    confidenceAdjustment += 1;
    softReasons.push("Session narrative aligned: +1 confidence");
  }

  const baseConfidence = Number(candidate.confidence ?? 0);
  const finalConfidence = Math.max(0, Math.min(100, baseConfidence + confidenceAdjustment));

  return {
    ...candidate,
    baseConfidence,
    confidence: finalConfidence,
    confidenceAdjustment,
    softReasons,
  };
}

'''

REJECTION_PATTERNS = [
    r'if\s*\([^)]*calibration[^)]*\)\s*{\s*return\s*{[^}]*rejected[^}]*}\s*;?\s*}',
    r'if\s*\([^)]*regime[^)]*\)\s*{\s*return\s*{[^}]*rejected[^}]*}\s*;?\s*}',
    r'if\s*\([^)]*opportunityCost[^)]*\)\s*{\s*return\s*{[^}]*rejected[^}]*}\s*;?\s*}',
    r'if\s*\([^)]*liquidityIntent[^)]*\)\s*{\s*return\s*{[^}]*rejected[^}]*}\s*;?\s*}',
]

def backup(path: Path):
    dest = BACKUP / path.relative_to(ROOT)
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(path, dest)

def append_helper_if_needed(path: Path, text: str) -> str:
    if MARKER in text:
        return text
    return text.rstrip() + "\n" + SOFT_SCORING_HELPER + "\n"

def soften_rejections(text: str) -> str:
    for pattern in REJECTION_PATTERNS:
        text = re.sub(
            pattern,
            "// June 23 restore: previous hard rejection converted to soft scoring input.",
            text,
            flags=re.DOTALL | re.IGNORECASE,
        )
    return text

def add_candidate_scoring_call(text: str) -> str:
    if "applyJune23SoftFilterScoring(" in text and "const scoredCandidate" in text:
        return text

    candidate_patterns = [
        "return candidate;",
        "return signal;",
        "return tradeCandidate;",
        "return analysis;",
    ]

    for p in candidate_patterns:
        if p in text:
            replacement = f"""
const scoredCandidate = applyJune23SoftFilterScoring({p.replace("return ", "").replace(";", "")});
console.log("[JUNE23][SOFT_SCORE]", {{
  confidence: scoredCandidate.confidence,
  baseConfidence: scoredCandidate.baseConfidence,
  adjustment: scoredCandidate.confidenceAdjustment,
  reasons: scoredCandidate.softReasons,
}});
return scoredCandidate;"""
            text = text.replace(p, replacement, 1)
            break

    return text

def patch(path: Path):
    if not path.exists():
        print(f"Missing: {path}")
        return

    backup(path)

    text = path.read_text(errors="ignore")
    text = soften_rejections(text)
    text = append_helper_if_needed(path, text)
    text = add_candidate_scoring_call(text)

    path.write_text(text)
    print(f"Patched soft scoring in: {path}")

def main():
    if not SERVER.exists():
        raise SystemExit("ERROR: server/ folder not found. Run from repo root.")

    BACKUP.mkdir(exist_ok=True)

    for target in TARGETS:
        patch(target)

    print(f"\nBackups saved to: {BACKUP}")
    print("\nVerify with:")
    print('grep -R "June 23 soft-filter scoring\\|JUNE23\\]\\[SOFT_SCORE" server -n')

if __name__ == "__main__":
    main()
