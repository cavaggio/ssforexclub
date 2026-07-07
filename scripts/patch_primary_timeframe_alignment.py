from pathlib import Path
import re

candidate_files = []

for p in Path("server").rglob("*.js"):
    txt = p.read_text(errors="ignore")
    if (
        ("Alignment score" in txt or "alignment score" in txt or "timeframe score" in txt or "timeframeScore" in txt)
        and ("M15" in txt or "m15" in txt)
    ):
        candidate_files.append(p)

print("Candidate alignment files:")
for p in candidate_files:
    print(" -", p)

if not candidate_files:
    raise SystemExit(
        "No alignment file found automatically. Run the search command above and patch the file that prints 'Alignment score'."
    )

changed = []

for p in candidate_files:
    txt = p.read_text(errors="ignore")
    old = txt

    # Add import once.
    if "primaryTimeframeAlignment.js" not in txt:
        import_line = "import { evaluatePrimaryTimeframeAlignment } from './primaryTimeframeAlignment.js';\n"
        if txt.startswith("import "):
            last_import_end = 0
            for m in re.finditer(r"^import .+?;\n", txt, re.M):
                last_import_end = m.end()
            txt = txt[:last_import_end] + import_line + txt[last_import_end:]
        else:
            txt = import_line + txt

    # Replace common hard rejection reasons that are based on broad/6-TF alignment.
    txt = re.sub(
        r"`?Alignment score[^`'\"]+min[^`'\"]+`?",
        "`Primary timeframe alignment failed: Daily + H4 + M15 must align. H1/M30/M5 are context only.`",
        txt,
        flags=re.I,
    )

    txt = re.sub(
        r"['\"]Daily and 4H directional bias are not aligned\.?['\"]",
        "'Primary timeframe alignment failed: Daily + H4 + M15 must align.'",
        txt,
        flags=re.I,
    )

    # If a min-alignment threshold is clearly set to 55, lower it so it can no longer
    # block because H1/M30/M5 disagree. The boolean primary gate handles validity.
    txt = re.sub(r"(MIN_ALIGNMENT_SCORE\s*=\s*)55", r"\g<1>0", txt)
    txt = re.sub(r"(minAlignmentScore\s*[:=]\s*)55", r"\g<1>0", txt)
    txt = re.sub(r"(ALIGNMENT_MIN_SCORE\s*=\s*)55", r"\g<1>0", txt)

    # Insert a helper function if not present.
    if "function applyPrimaryTimeframeGate(" not in txt:
        helper = r"""

function applyPrimaryTimeframeGate(signalLike, direction) {
  const primary = evaluatePrimaryTimeframeAlignment(signalLike, direction);

  if (!signalLike || typeof signalLike !== 'object') return primary;

  signalLike.primaryTimeframeAlignment = primary;

  if (!Array.isArray(signalLike.warnings)) signalLike.warnings = [];
  if (!Array.isArray(signalLike.rejectionReasons)) signalLike.rejectionReasons = [];

  if (!primary.passed) {
    signalLike.rejectionReasons.push(primary.reason);
  } else if (primary.contextConflicts?.length) {
    signalLike.warnings.push(primary.reason);
    signalLike.rejectionReasons = signalLike.rejectionReasons.filter((r) => {
      const s = String(r || '').toLowerCase();
      return !(
        s.includes('alignment score') ||
        s.includes('timeframe score') ||
        s.includes('h1') ||
        s.includes('m30') ||
        s.includes('m5')
      );
    });
  }

  return primary;
}
"""
        # Place helper before first exported scanner/analyzer function, or append.
        marker = "\nexport "
        idx = txt.find(marker)
        if idx > 0:
            txt = txt[:idx] + helper + txt[idx:]
        else:
            txt += helper

    if txt != old:
        p.write_text(txt)
        changed.append(p)

print("\nPatched files:")
for p in changed:
    print(" -", p)

if not changed:
    print("\nNo files changed. The repo may already be patched or the alignment gate has a different shape.")
