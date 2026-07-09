from pathlib import Path
import re

VISIBLE = "['OPENED', 'CLOSED', 'ERROR', 'opened', 'closed', 'error']"

candidates = []

for p in Path(".").rglob("*"):
    if any(x in p.parts for x in ["node_modules", ".git", "dist", "build", ".next", ".vercel"]):
        continue
    if p.suffix.lower() not in [".js", ".jsx", ".ts", ".tsx"]:
        continue

    txt = p.read_text(errors="ignore")
    if ("trade_logs" in txt or "tradeLogs" in txt or "Trade Logs" in txt) and ("REASSESSED" in txt or "reassessed" in txt or ".select(" in txt):
        candidates.append(p)

print("Candidate trade-log files:")
for p in candidates:
    print(" -", p)

changed = []

for p in candidates:
    txt = p.read_text(errors="ignore")
    old = txt

    # If the file is fetching from Supabase trade_logs without a status filter,
    # add a visible event filter after .select(...).
    txt = re.sub(
        r"(\.from\(['\"]trade_logs['\"]\)\s*\n\s*\.select\([^\)]*\))",
        r"\1\n        .in('status', " + VISIBLE + r")",
        txt,
        count=1,
    )

    # If the UI maps/filter logs in memory, add a defensive filter.
    txt = txt.replace(
        ".map((log",
        f".filter((log) => {VISIBLE}.includes(log.status || log.event || log.event_type || log.type))\n        .map((log",
    )

    if txt != old:
        p.write_text(txt)
        changed.append(p)

print("\nPatched:")
for p in changed:
    print(" -", p)

if not changed:
    print("\nNo automatic UI patch applied. Use the candidate list above and manually add:")
    print("  .in('status', ['OPENED','CLOSED','ERROR','opened','closed','error'])")
    print("or filter out REASSESSED before rendering.")
