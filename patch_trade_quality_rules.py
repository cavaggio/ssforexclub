from pathlib import Path
import re

ROOT = Path.cwd()

FILES = [
    "server/ictAutoScheduler.js",
    "server/ictExecution.js",
    "server/v3AutoTrade.js",
    "server/autoAiRouter.js",
    "server/tradeDecisionEngine.js",
    "server/oandaExpectedRR.js",
]

def patch_file(path):
    p = ROOT / path
    if not p.exists():
        print(f"SKIP missing {path}")
        return

    s = p.read_text()

    original = s

    # 1) Extend auto trading/scanning window to 2am–11am
    s = re.sub(r'END_HOUR\s*=\s*10\b', 'END_HOUR = 11', s)
    s = re.sub(r'endHour\s*:\s*10\b', 'endHour: 11', s)
    s = re.sub(r'autoAiEndHour\s*=\s*10\b', 'autoAiEndHour = 11', s)
    s = re.sub(r'AUTO_AI_END_HOUR\s*\|\|\s*[\'"]10[\'"]', 'AUTO_AI_END_HOUR || "11"', s)
    s = re.sub(r'ICT_AUTO_END_HOUR\s*\|\|\s*[\'"]10[\'"]', 'ICT_AUTO_END_HOUR || "11"', s)
    s = re.sub(r'V3_AUTO_END_HOUR\s*\|\|\s*[\'"]10[\'"]', 'V3_AUTO_END_HOUR || "11"', s)

    # 2) Ensure start stays 2am where hardcoded
    s = re.sub(r'BEGIN_HOUR\s*=\s*\d+\b', 'BEGIN_HOUR = 2', s)
    s = re.sub(r'START_HOUR\s*=\s*\d+\b', 'START_HOUR = 2', s)
    s = re.sub(r'startHour\s*:\s*\d+\b', 'startHour: 2', s)

    # 3) Raise min confidence to 80 for ICT, V3, Forex
    s = re.sub(r'minConfidence\s*:\s*7[0-9]\b', 'minConfidence: 80', s)
    s = re.sub(r'minConfidence\s*=\s*7[0-9]\b', 'minConfidence = 80', s)
    s = re.sub(r'ICT_MIN_CONFIDENCE\s*\|\|\s*[\'"]?\d+[\'"]?', 'ICT_MIN_CONFIDENCE || 80', s)
    s = re.sub(r'FOREX_MIN_CONFIDENCE\s*\|\|\s*[\'"]?\d+[\'"]?', 'FOREX_MIN_CONFIDENCE || 80', s)
    s = re.sub(r'V3_MIN_CONFIDENCE\s*\|\|\s*[\'"]?\d+[\'"]?', 'V3_MIN_CONFIDENCE || 80', s)

    # 4) Hard minimum RR 1.5 where lower defaults exist
    s = re.sub(r'minRR\s*:\s*1(?:\.0)?\b', 'minRR: 1.5', s)
    s = re.sub(r'minRR\s*=\s*1(?:\.0)?\b', 'minRR = 1.5', s)
    s = re.sub(r'ICT_MIN_RR\s*\|\|\s*[\'"]?1(?:\.0)?[\'"]?', 'ICT_MIN_RR || 1.5', s)
    s = re.sub(r'FOREX_MIN_RR\s*\|\|\s*[\'"]?1(?:\.0)?[\'"]?', 'FOREX_MIN_RR || 1.5', s)
    s = re.sub(r'V3_MIN_RR\s*\|\|\s*[\'"]?1(?:\.0)?[\'"]?', 'V3_MIN_RR || 1.5', s)

    # 5) Replace hard late/early rejection wording where present
    s = s.replace("entryTiming === 'LATE_ENTRY'", "false && entryTiming === 'LATE_ENTRY'")
    s = s.replace("entryTiming === 'TOO_EARLY'", "false && entryTiming === 'TOO_EARLY'")
    s = s.replace("entryQuality?.timing === 'LATE_ENTRY'", "false && entryQuality?.timing === 'LATE_ENTRY'")
    s = s.replace("entryQuality?.timing === 'TOO_EARLY'", "false && entryQuality?.timing === 'TOO_EARLY'")

    if s != original:
        p.write_text(s)
        print(f"PATCHED {path}")
    else:
        print(f"NO CHANGE {path}")

for f in FILES:
    patch_file(f)

print("\nPatch complete.")
