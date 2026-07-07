from pathlib import Path

p = Path("server/oandaMtfAnalysis.js")
txt = p.read_text()

bad = """  // `Primary timeframe alignment failed: Daily + H4 + M15 must align. H1/M30/M5 are context only.`'ranging') {
    rejectionReasons.push('Macro bias is ranging — no directional trade qualified');
  } else if (!momentum.executionSignal) {"""

good = """  if (macroDir === 'ranging') {
    rejectionReasons.push('Macro bias is ranging — no directional trade qualified');
  } else if (!momentum.executionSignal) {"""

if bad not in txt:
    print("Exact corrupted block not found. Showing nearby lines:")
    lines = txt.splitlines()
    for n in range(760, 785):
        if n <= len(lines):
            print(f"{n}: {lines[n-1]}")
    raise SystemExit(1)

p.write_text(txt.replace(bad, good))
print("Fixed server/oandaMtfAnalysis.js syntax.")
