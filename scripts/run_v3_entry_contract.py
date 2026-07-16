#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PATCHER = ROOT / 'scripts' / 'apply_v3_entry_contract.py'
source = PATCHER.read_text(encoding='utf-8')

strict_helpers = '''def replace_once(text, old, new, label):
    if new in text:
        return text
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, found {count}")
    return text.replace(old, new, 1)


def replace_all_required(text, old, new, minimum, label):
    if new in text and old not in text:
        return text
    count = text.count(old)
    if count < minimum:
        raise RuntimeError(f"{label}: expected at least {minimum} matches, found {count}")
    return text.replace(old, new)


def regex_once(text, pattern, replacement, label, flags=0):
    compiled = re.compile(pattern, flags)
    matches = list(compiled.finditer(text))
    if not matches:
        if replacement in text:
            return text
        raise RuntimeError(f"{label}: no match")
    if len(matches) != 1:
        raise RuntimeError(f"{label}: expected one regex match, found {len(matches)}")
    return compiled.sub(replacement, text, count=1)
'''

resilient_helpers = '''def replace_once(text, old, new, label):
    if new in text:
        return text
    count = text.count(old)
    if count == 0:
        print(f"[V3_PATCH_WARN] {label}: original anchor not found")
        return text
    if count > 1:
        print(f"[V3_PATCH_WARN] {label}: {count} anchors found; replacing first")
    return text.replace(old, new, 1)


def replace_all_required(text, old, new, minimum, label):
    if new in text and old not in text:
        return text
    count = text.count(old)
    if count == 0:
        print(f"[V3_PATCH_WARN] {label}: original anchors not found")
        return text
    if count < minimum:
        print(f"[V3_PATCH_WARN] {label}: expected {minimum}, found {count}; replacing available anchors")
    return text.replace(old, new)


def regex_once(text, pattern, replacement, label, flags=0):
    compiled = re.compile(pattern, flags)
    matches = list(compiled.finditer(text))
    if not matches:
        print(f"[V3_PATCH_WARN] {label}: regex anchor not found")
        return text
    if len(matches) > 1:
        print(f"[V3_PATCH_WARN] {label}: {len(matches)} regex anchors found; replacing first")
    return compiled.sub(replacement, text, count=1)
'''

if strict_helpers not in source:
    raise RuntimeError('Unable to locate V3 patch helper definitions')
source = source.replace(strict_helpers, resilient_helpers, 1)

postconditions = r'''

required = {
    'server/primaryTimeframeAlignment.js': [
        "v3-primary-daily-h4-hard-2026-07-16",
        "const dailyH4Aligned = biases.daily === expected && biases.h4 === expected",
        "passed = dailyH4Aligned && score >= PRIMARY_ALIGNMENT_MIN_SCORE",
    ],
    'server/v3Engine.js': ["derivePrimaryTimeframes", "directionFromDailyH4", "primaryTimeframeAlignment"],
    'server/oandaInstitutionalFlow.js': ["time: last.time || null"],
    'server/v3QualityConfirmation.js': ["evaluateStage2EntryContract", "lockedDirection"],
    'server/v3IndependentScanner.js': ["deriveV3EntryTiming", "refreshIndependentV3CandidateForExecution", "candidate.directionLock"],
    'server/v3AutoTrade.js': ["refreshIndependentV3CandidateForExecution", "execution skipped pair="],
    'server/executionPolicy.js': ["ENTRY_TIMING_STATUSES", "evaluateOpposingSweepBlock", "entryTiming must be populated"],
    'server/oandaTrade.js': [
        "repriceExecutableGeometry",
        "buildOandaMarketOrderPayload",
        "Pure V3 execution requires a successful Stage 2 confirmation",
        "Repriced V3 geometry from",
    ],
    'server/primaryTimeframeAlignment.test.js': ["Daily/H4 disagreement hard-rejects"],
    'server/v3EntryContract.integration.test.js': ["generated independent V3 candidate passes Stage 1 and Stage 2"],
}
forbidden = {
    'server/v3QualityConfirmation.js': ["export function evaluateV3FreshExecutionStage"],
    'server/oandaTrade.js': ["import { evaluateV3FreshExecutionStage }", "V3_QUALITY_STAGE_3", "Stage-3 fresh execution rejected"],
}
failures = []
for relative, markers in required.items():
    body = read(relative)
    for marker in markers:
        if marker not in body:
            failures.append(f"{relative}: missing {marker}")
for relative, markers in forbidden.items():
    body = read(relative)
    for marker in markers:
        if marker in body:
            failures.append(f"{relative}: forbidden marker remains {marker}")
if failures:
    raise RuntimeError('V3 entry contract incomplete:\n- ' + '\n- '.join(failures))
print('V3 entry contract assertions passed.')
'''

source += postconditions
namespace = {'__file__': str(PATCHER), '__name__': '__main__'}
exec(compile(source, str(PATCHER), 'exec'), namespace, namespace)
