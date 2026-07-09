from pathlib import Path
import sys

SCANNER = Path("server/oandaScanner.js")

def die(msg):
    print(f"❌ {msg}", file=sys.stderr)
    sys.exit(1)

if not SCANNER.exists():
    die("server/oandaScanner.js not found. Run from repo root.")

text = SCANNER.read_text()
original = text

marker = "\n// === PERFECT ALIGNMENT EXECUTION BYPASS PATCH ==="
marker_idx = text.find(marker)

if marker_idx == -1:
    die("Could not find PERFECT ALIGNMENT patch marker.")

prefix = text[:marker_idx]

# This is the broken orphan fragment currently sitting before the real helper:
# = {}) {
#   const alignScore = ...
orphan_idx = prefix.rfind("\n= {}) {")

if orphan_idx == -1:
    print("⚠️ No orphan '= {}) {' fragment found. Showing nearby lines:")
    print("Run: nl -ba server/oandaScanner.js | sed -n '1425,1475p'")
else:
    text = text[:orphan_idx] + "\n" + text[marker_idx:]
    backup = SCANNER.with_suffix(".js.bak_orphan_perfect_alignment_fragment")
    backup.write_text(original)
    SCANNER.write_text(text)
    print("✅ Removed orphan perfect-alignment fragment.")
    print(f"🗂️ Backup saved: {backup}")

print("\nNow verify with:")
print("node --check server/oandaScanner.js")
print("grep -n \"= {}) {\\|function shouldForcePerfectAlignmentExecution\\|function softenPerfectAlignmentRejects\" server/oandaScanner.js")
