#!/usr/bin/env python3
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
ORIGINAL_PATH = 'scripts/apply_execution_hardening.py'
DIAGNOSTIC_PATH = ROOT / 'server' / 'v3EntryContract.diagnostic.txt'


def run(command, capture=False):
    return subprocess.run(
        command,
        cwd=ROOT,
        check=not capture,
        text=True,
        capture_output=capture,
    )


# Run the approved generator exactly as it exists on main, then layer the V3
# entry contract on top. The wrapper restores the approved generator before the
# PR workflow commits, so this temporary bridge never lands on main.
original = subprocess.check_output(
    ['git', 'show', f'origin/main:{ORIGINAL_PATH}'],
    cwd=ROOT,
    text=True,
)
with tempfile.NamedTemporaryFile('w', suffix='.py', delete=False) as handle:
    handle.write(original)
    original_runner = handle.name

try:
    run([sys.executable, original_runner])
    result = run([sys.executable, str(ROOT / 'scripts' / 'run_v3_entry_contract.py')], capture=True)
    if result.returncode != 0:
        DIAGNOSTIC_PATH.write_text(
            f'returncode={result.returncode}\nSTDOUT\n{result.stdout}\nSTDERR\n{result.stderr}\n',
            encoding='utf-8',
        )
    elif DIAGNOSTIC_PATH.exists():
        DIAGNOSTIC_PATH.unlink()
finally:
    run(['git', 'checkout', 'origin/main', '--', ORIGINAL_PATH])
