#!/usr/bin/env python3
"""Make every ICT scanner path use the ICT-owned 12-pair core watchlist.

The repository uses idempotent source-enforcement scripts during pretest,
prebuild, and prestart. This patch removes the retired eight-pair constant from
ictEngine.js and points the engine's own fallback at configuredIctWatchlist().
"""

from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / "server" / "ictEngine.js"

IMPORT_LINE = "import { configuredIctWatchlist } from './ictWatchlist.js';"
OLD_BLOCK = re.compile(
    r"const DEFAULT_ICT_PAIRS = \[[^\n]+\];\n"
    r"const ICT_PAIRS = \(process\.env\.ICT_PAIRS \|\| process\.env\.FOREX_WATCHLIST\)\n"
    r"  \? \(process\.env\.ICT_PAIRS \|\| process\.env\.FOREX_WATCHLIST\)\.split\(','\)\.map\(\(p\) => p\.trim\(\)\)\.filter\(Boolean\)\n"
    r"  : DEFAULT_ICT_PAIRS;"
)
NEW_BLOCK = "const ICT_PAIRS = configuredIctWatchlist();"


def main() -> None:
    text = TARGET.read_text(encoding="utf-8")

    if IMPORT_LINE not in text:
        anchor = "import { getNewsRisk } from './news/forexFactoryNews.js';"
        if anchor not in text:
            raise SystemExit("ICT watchlist patch failed: news import anchor not found")
        text = text.replace(anchor, f"{anchor}\n{IMPORT_LINE}", 1)

    if OLD_BLOCK.search(text):
        text = OLD_BLOCK.sub(NEW_BLOCK, text, count=1)
    elif NEW_BLOCK not in text:
        raise SystemExit("ICT watchlist patch failed: old/default watchlist block not found")

    if "DEFAULT_ICT_PAIRS" in text:
        raise SystemExit("ICT watchlist patch failed: retired eight-pair constant remains")
    if text.count(IMPORT_LINE) != 1:
        raise SystemExit("ICT watchlist patch failed: configured watchlist import is not unique")
    if text.count(NEW_BLOCK) != 1:
        raise SystemExit("ICT watchlist patch failed: configured watchlist assignment is not unique")

    TARGET.write_text(text, encoding="utf-8")
    print("ICT watchlist enforced: engine default uses the 12 core pairs")


if __name__ == "__main__":
    main()
