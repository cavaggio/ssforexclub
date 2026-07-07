from pathlib import Path
from collections import Counter
import json
import os
import urllib.parse
import urllib.request
import urllib.error

def load_env():
    env = dict(os.environ)
    for name in [".env.production.local", ".env.local", ".env"]:
        p = Path(name)
        if not p.exists():
            continue
        for line in p.read_text(errors="ignore").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    return env

env = load_env()
url = (env.get("NEXT_PUBLIC_SUPABASE_URL") or env.get("SUPABASE_URL") or "").rstrip("/")
key = env.get("SUPABASE_SERVICE_ROLE_KEY") or env.get("SUPABASE_ANON_KEY") or env.get("NEXT_PUBLIC_SUPABASE_ANON_KEY")

if not url or not key:
    raise SystemExit("Missing Supabase env. Run: npx vercel env pull .env.production.local --environment=production")

qs = urllib.parse.urlencode({
    "select": "*",
    "order": "created_at.desc",
    "limit": "500",
})

req = urllib.request.Request(
    f"{url}/rest/v1/trade_logs?{qs}",
    headers={
        "apikey": key,
        "Authorization": f"Bearer {key}",
    }
)

with urllib.request.urlopen(req, timeout=30) as r:
    rows = json.loads(r.read().decode("utf-8"))

def pick(row, keys):
    for k in keys:
        v = row.get(k)
        if v not in [None, ""]:
            return v
    return None

counts = Counter()
closed = []
opened = []
reassessed = []

for row in rows:
    event = str(pick(row, ["status", "event", "event_type", "type", "action"]) or "").upper()
    counts[event or "<blank>"] += 1
    if event == "CLOSED":
        closed.append(row)
    elif event == "OPENED":
        opened.append(row)
    elif event == "REASSESSED":
        reassessed.append(row)

print("Event counts:")
for k, v in counts.most_common():
    print(f"  {k}: {v}")

print(f"\nOPENED rows: {len(opened)}")
print(f"CLOSED rows: {len(closed)}")
print(f"REASSESSED rows: {len(reassessed)}")

if len(closed) == 0:
    print("\nPROBLEM CONFIRMED: no CLOSED trade-log rows found.")
    print("Edge Intelligence should remain 0 until closeBrokerTrade / auto-close writes CLOSED rows.")
else:
    print("\nSample CLOSED row keys:")
    print(sorted(closed[0].keys()))
    print(json.dumps({k: closed[0].get(k) for k in sorted(closed[0].keys())[:25]}, indent=2, default=str))
