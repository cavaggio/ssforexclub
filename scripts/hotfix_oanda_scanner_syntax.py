from pathlib import Path

p = Path("server/oandaScanner.js")
lines = p.read_text().splitlines()

out = []
i = 0
patched = False

while i < len(lines):
    line = lines[i]

    if "score: alignment.timeframeAlignmentScore" in line:
        indent = line.split("score:")[0]

        out.append(f"{indent}score: alignment.timeframeAlignmentScore,    // 0–100 primary timeframe score")
        out.append(f"{indent}liquiditySweepDetected: (institutionalFlow?.signals || []).some(")
        out.append(f"{indent}  s => s.type === 'liquidity_sweep' || s.subtype === 'failed_breakout'")
        out.append(f"{indent}),")

        # Skip the corrupted score line and the orphan line immediately after it.
        i += 1
        if i < len(lines) and lines[i].strip() == "),":
            i += 1

        patched = True
        continue

    out.append(line)
    i += 1

if not patched:
    raise SystemExit("Did not find corrupted score/liquiditySweepDetected block.")

p.write_text("\n".join(out) + "\n")
print("Repaired server/oandaScanner.js corrupted score/liquiditySweepDetected block.")
