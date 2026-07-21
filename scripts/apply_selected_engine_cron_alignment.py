#!/usr/bin/env python3
"""Keep both Auto AI cron routes aligned to selected-engine-only behavior."""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ROUTE = ROOT / "web" / "app" / "api" / "cron" / "auto-ai-trading" / "route.ts"

text = ROUTE.read_text(encoding="utf-8")
text = text.replace(
    "return minutes >= 135 && minutes < 660;",
    "return minutes >= 120 && minutes < 600;",
)
text = text.replace(
    "const engine = row.auto_ai_engine === 'v3' ? 'v3' : 'ict';",
    "const engine = row.auto_ai_engine === 'v3'\n"
    "      ? 'v3'\n"
    "      : row.auto_ai_engine === 'ppr'\n"
    "        ? 'ppr'\n"
    "        : 'ict';",
)
text = text.replace(
    "Retains the currently deployed 02:15–11:00 ET entry window.",
    "Scanning begins at 02:00 ET; the engine-neutral router blocks new orders until 02:15 ET.",
)

for marker in [
    "return minutes >= 120 && minutes < 600;",
    "row.auto_ai_engine === 'ppr'",
    "engine,",
]:
    if marker not in text:
        raise RuntimeError(f"selected-engine cron alignment incomplete: missing {marker}")

ROUTE.write_text(text, encoding="utf-8")
print("Standard Auto AI cron aligned: selected engine only, scan at 02:00, entry gate at 02:15")
