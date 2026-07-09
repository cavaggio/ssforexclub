from pathlib import Path
from datetime import datetime
import shutil
import sys

ROOT = Path.cwd()
FILE = ROOT / "server/v3AutoTrade.js"
STAMP = datetime.now().strftime("%Y%m%d_%H%M%S")
BACKUP = ROOT / f"backup_fix_v3_empty_watchlist_{STAMP}"

if not FILE.exists():
    print("❌ Missing server/v3AutoTrade.js")
    sys.exit(1)

BACKUP.mkdir(exist_ok=True)
shutil.copy2(FILE, BACKUP / "v3AutoTrade.js")

text = FILE.read_text()
original = text

old = """  const scanPairs = prioritizeRetraceWatchPairs(Array.isArray(pairs) && pairs.length ? pairs : []);
  log(`scan started scanMode=${scanMode} pairs=${scanPairs?.length ? scanPairs.join(',') : 'ALL'}`);

  const scan = await scanForexPairs(scanPairs, { client, scanMode });"""

new = """  const requestedPairs = Array.isArray(pairs) && pairs.length ? pairs : null;
  const scanPairs = requestedPairs ? prioritizeRetraceWatchPairs(requestedPairs) : null;

  log(`scan started scanMode=${scanMode} pairs=${scanPairs?.length ? scanPairs.join(',') : 'ALL'}`);

  const scan = await scanForexPairs(scanPairs, { client, scanMode });"""

if old not in text:
    print("❌ Could not find the exact V3 scanPairs block.")
    print("Search manually:")
    print("grep -nE \"scanPairs|scanForexPairs\" server/v3AutoTrade.js")
    sys.exit(1)

text = text.replace(old, new, 1)

# Keep the helper safe in case near/hot scans pass unexpected values.
old_fn = """function prioritizeRetraceWatchPairs(pairs = []) {
  const watched = getRetraceWatchPairs();
  return [...new Set([...watched, ...pairs])];
}"""

new_fn = """function prioritizeRetraceWatchPairs(pairs = []) {
  const watched = getRetraceWatchPairs();
  const basePairs = Array.isArray(pairs) ? pairs : [];
  return [...new Set([...watched, ...basePairs])];
}"""

if old_fn in text:
    text = text.replace(old_fn, new_fn, 1)

FILE.write_text(text)

print("✅ Fixed V3 full scan to use default watchlist instead of empty instrument list.")
print(f"Backup saved in {BACKUP}")
