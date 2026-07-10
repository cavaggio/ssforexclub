from pathlib import Path
import sys

FILE = Path("web/components/scanner-status-card.tsx")

if not FILE.exists():
    print("❌ web/components/scanner-status-card.tsx not found. Run from repo root.", file=sys.stderr)
    sys.exit(1)

text = FILE.read_text()
original = text

old = """function isSubMinRrDisplay(sig: any, minRR = 1.5): boolean {
  const rr = rrFromDisplayedSignal(sig);
  if (Number.isFinite(rr) && rr < minRR) return true;
  return hasSubMinRrText(sig, minRR);
}
"""

new = """function isSubMinRrDisplay(sig: any, minRR = 1.5): boolean {
  const rr = rrFromDisplayedSignal(sig);
  if (rr !== null && Number.isFinite(rr) && rr < minRR) return true;
  return hasSubMinRrText(sig, minRR);
}
"""

if old not in text:
    print("❌ Could not find exact isSubMinRrDisplay block.", file=sys.stderr)
    print("Run this to inspect it:")
    print("grep -n \"function isSubMinRrDisplay\" -A8 web/components/scanner-status-card.tsx")
    sys.exit(1)

text = text.replace(old, new, 1)

backup = FILE.with_suffix(".tsx.bak_rr_null_typecheck")
backup.write_text(original)
FILE.write_text(text)

print("✅ Fixed TypeScript null narrowing for R:R dashboard guard.")
print(f"🗂️ Backup saved: {backup}")
