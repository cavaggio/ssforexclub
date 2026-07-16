#!/usr/bin/env python3
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]

# Temporary PR-validation bridge: the reviewed feature branch already contains
# the generated hardening source. Re-apply only the idempotent V3 Stage 2
# contract so the legacy main-branch workflow cannot rewrite unrelated files.
subprocess.run(
    [sys.executable, str(ROOT / 'scripts' / 'run_v3_entry_contract.py')],
    cwd=ROOT,
    check=True,
)
