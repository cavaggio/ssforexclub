from pathlib import Path
from datetime import datetime
import shutil
import sys

ROOT = Path.cwd()
FILE = ROOT / "server/v3AutoTrade.js"
STAMP = datetime.now().strftime("%Y%m%d_%H%M%S")
BACKUP = ROOT / f"backup_fix_v3_pairs_{STAMP}"

if not FILE.exists():
    print("❌ Missing server/v3AutoTrade.js")
    sys.exit(1)

BACKUP.mkdir(exist_ok=True)
shutil.copy2(FILE, BACKUP / "v3AutoTrade.js")

text = FILE.read_text()
original = text

old_call = "const scanPairs = prioritizeRetraceWatchPairs(Array.isArray(pairs) && pairs.length ? pairs : null);"
new_call = "const scanPairs = prioritizeRetraceWatchPairs(Array.isArray(pairs) && pairs.length ? pairs : []);"

old_fn = """function prioritizeRetraceWatchPairs(pairs = []) {
  const watched = getRetraceWatchPairs();
  return [...new Set([...watched, ...pairs])];
}"""

new_fn = """function prioritizeRetraceWatchPairs(pairs = []) {
  const watched = getRetraceWatchPairs();
  const basePairs = Array.isArray(pairs) ? pairs : [];
  return [...new Set([...watched, ...basePairs])];
}"""

if old_call in text:
    text = text.replace(old_call, new_call, 1)
else:
    print("⚠️ Exact scanPairs call not found; checking if already fixed.")

if old_fn in text:
    text = text.replace(old_fn, new_fn, 1)
else:
    print("⚠️ Exact prioritizeRetraceWatchPairs function not found; checking if already fixed.")

if text == original:
    print("⚠️ No changes made. Open server/v3AutoTrade.js and inspect scanPairs/prioritizeRetraceWatchPairs manually.")
else:
    FILE.write_text(text)
    print("✅ Fixed V3 pairs not iterable bug.")
    print(f"Backup saved in {BACKUP}")
