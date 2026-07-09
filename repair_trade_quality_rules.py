from pathlib import Path
import re

ROOT = Path.cwd()

def replace_env_default(s, env_name, value):
    patterns = [
        rf"process\.env\.{env_name}\s*\|\|\s*['\"]?[\d.]+['\"]?",
        rf"Number\(process\.env\.{env_name}\s*\|\|\s*['\"]?[\d.]+['\"]?\)",
        rf"parseFloat\(process\.env\.{env_name}\s*\|\|\s*['\"]?[\d.]+['\"]?\)",
        rf"parseInt\(process\.env\.{env_name}\s*\|\|\s*['\"]?[\d.]+['\"]?,?\s*10?\)",
    ]
    for pat in patterns:
        s = re.sub(pat, lambda m: m.group(0).split("process.env")[0] + f"process.env.{env_name} || '{value}'" + (")" if m.group(0).count("(") > m.group(0).count(")") else ""), s)
    return s

files = list((ROOT / "server").glob("*.js"))

for p in files:
    s = p.read_text()
    old = s

    # Revert unsafe replacements from prior patch
    s = s.replace("false && entryTiming === 'LATE_ENTRY'", "entryTiming === 'LATE_ENTRY'")
    s = s.replace("false && entryTiming === 'TOO_EARLY'", "entryTiming === 'TOO_EARLY'")
    s = s.replace("false && entryQuality?.timing === 'LATE_ENTRY'", "entryQuality?.timing === 'LATE_ENTRY'")
    s = s.replace("false && entryQuality?.timing === 'TOO_EARLY'", "entryQuality?.timing === 'TOO_EARLY'")

    # Conservative defaults only
    s = re.sub(r"\bminConfidence\s*:\s*7[0-9]\b", "minConfidence: 80", s)
    s = re.sub(r"\bminConfidence\s*=\s*7[0-9]\b", "minConfidence = 80", s)

    s = re.sub(r"\bminRR\s*:\s*(?:0\.\d+|1(?:\.0)?)\b", "minRR: 1.5", s)
    s = re.sub(r"\bminRR\s*=\s*(?:0\.\d+|1(?:\.0)?)\b", "minRR = 1.5", s)

    s = re.sub(r"\bEND_HOUR\s*=\s*10\b", "END_HOUR = 11", s)
    s = re.sub(r"\bendHour\s*:\s*10\b", "endHour: 11", s)

    if s != old:
        p.write_text(s)
        print("patched", p)

print("done")
