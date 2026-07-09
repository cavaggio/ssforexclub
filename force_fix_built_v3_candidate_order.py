from pathlib import Path
from datetime import datetime
import shutil
import sys

FILE = Path("server/v3AutoTrade.js")
STAMP = datetime.now().strftime("%Y%m%d_%H%M%S")
BACKUP_DIR = Path(f"backup_force_fix_built_v3_order_{STAMP}")

if not FILE.exists():
    print("❌ Missing server/v3AutoTrade.js")
    sys.exit(1)

BACKUP_DIR.mkdir(exist_ok=True)
shutil.copy2(FILE, BACKUP_DIR / "v3AutoTrade.js")

lines = FILE.read_text().splitlines()

built_line = "    const builtV3Candidate = buildV3PropFirmCandidate(item, v3, minRR);"

# Remove every existing builtV3Candidate declaration line.
lines = [line for line in lines if line.strip() != built_line.strip()]

# Find the RR line that uses builtV3Candidate.
rr_idx = None
for i, line in enumerate(lines):
    if "const rr = envNum(" in line and "builtV3Candidate?.expectedRR" in line:
        rr_idx = i
        break

if rr_idx is None:
    print("❌ Could not find the RR line using builtV3Candidate.")
    print("Run: grep -nE \"builtV3Candidate|const rr =|expectedRR\" server/v3AutoTrade.js")
    sys.exit(1)

# Insert declaration immediately before RR calculation.
lines.insert(rr_idx, built_line)

FILE.write_text("\n".join(lines) + "\n")

print("✅ Forced builtV3Candidate declaration before RR calculation.")
print(f"Backup saved in {BACKUP_DIR}")
