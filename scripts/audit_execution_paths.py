from pathlib import Path

ROOT = Path.cwd()
SERVER = ROOT / "server"

terms = [
    "client.post(`/v3/accounts/${accountId}/orders`",
    "oandaPost(`/v3/accounts/${accountId}/orders`",
    "executeTrade",
    "confidence",
    "riskReward",
    "expectedRR",
    "liquidity",
    "premium",
    "discount",
    "calibration",
    "regime",
    "opportunityCost",
]

for path in SERVER.rglob("*.js"):
    text = path.read_text(errors="ignore")
    hits = [t for t in terms if t in text]
    if hits:
        print(f"\n--- {path} ---")
        for h in hits:
            print(f"  HIT: {h}")
