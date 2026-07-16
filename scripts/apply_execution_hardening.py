#!/usr/bin/env python3
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
ORIGINAL_PATH = 'scripts/apply_execution_hardening.py'
OUTPUT_PATH = ROOT / 'server' / 'v3CiDiagnostics.txt'


def capture(label, command):
    result = subprocess.run(command, cwd=ROOT, text=True, capture_output=True)
    return (
        f'\n===== {label} =====\n'
        f'command={command!r}\nreturncode={result.returncode}\n'
        f'STDOUT\n{result.stdout}\nSTDERR\n{result.stderr}\n'
    )

sections = []
sections.append(capture('apply V3 contract', [sys.executable, str(ROOT / 'scripts' / 'run_v3_entry_contract.py')]))
sections.append(capture('npm ci', ['npm', 'ci']))
sections.append(capture('independent V3', ['node', '--test', 'server/v3IndependentScanner.test.js']))
sections.append(capture('provisioning policy', [
    'node', '--test',
    'server/primaryTimeframeAlignment.test.js',
    'web/lib/v3ScanDisplayPolicy.test.js',
    'web/lib/edgeExecutionProfile.test.js',
]))
sections.append(capture('native V3', [
    'node', '--test',
    'server/v3QualityConfirmation.test.js',
    'server/v3RetestExecutionPolicy.test.js',
    'server/v3NativeEntryTiming.test.js',
    'server/v3WatchClassification.test.js',
    'server/v3PrimaryAlignment.test.js',
    'server/v3NativeScanner.test.js',
    'server/ictAutoScheduler.test.js',
    'server/autoAiRouter.test.js',
]))
sections.append(capture('entry contract integration', [
    'node', '--test', 'server/v3EntryContract.integration.test.js',
]))
sections.append(capture('full server suite', ['npm', 'test']))
OUTPUT_PATH.write_text(''.join(sections), encoding='utf-8')

subprocess.run(
    ['git', 'checkout', 'origin/main', '--', ORIGINAL_PATH],
    cwd=ROOT,
    check=True,
)
