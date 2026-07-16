#!/usr/bin/env python3
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
ORIGINAL_PATH = 'scripts/apply_execution_hardening.py'
DIAGNOSTIC_PATH = ROOT / 'server' / 'v3EntryContract.diagnostic.txt'

result = subprocess.run(
    [sys.executable, str(ROOT / 'scripts' / 'run_v3_entry_contract.py')],
    cwd=ROOT,
    text=True,
    capture_output=True,
)

if result.returncode != 0:
    subprocess.run(['git', 'checkout', 'HEAD', '--', 'server', 'package.json'], cwd=ROOT, check=True)
    DIAGNOSTIC_PATH.write_text(
        f'returncode={result.returncode}\nSTDOUT\n{result.stdout}\nSTDERR\n{result.stderr}\n',
        encoding='utf-8',
    )
else:
    print(result.stdout)
    if DIAGNOSTIC_PATH.exists():
        DIAGNOSTIC_PATH.unlink()

subprocess.run(
    ['git', 'checkout', 'origin/main', '--', ORIGINAL_PATH],
    cwd=ROOT,
    check=True,
)
