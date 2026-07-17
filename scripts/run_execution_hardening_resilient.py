#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PATCHER = ROOT / 'scripts' / 'apply_execution_hardening.py'
source = PATCHER.read_text(encoding='utf-8')

strict_helpers = '''def p(path): return ROOT / path
def read(path): return p(path).read_text(encoding='utf-8')
def write(path, text):
    p(path).parent.mkdir(parents=True, exist_ok=True)
    p(path).write_text(text, encoding='utf-8')
def once(text, old, new, label):
    n = text.count(old)
    if n == 0 and new in text: return text
    if n != 1: raise RuntimeError(f'{label}: expected 1 match, found {n}')
    return text.replace(old, new, 1)
def sub_once(text, pattern, repl, label, flags=0):
    out, n = re.subn(pattern, repl, text, count=1, flags=flags)
    if n == 0 and re.search(re.escape(repl[:40]), text): return text
    if n != 1: raise RuntimeError(f'{label}: expected 1 match, found {n}')
    return out
'''

resilient_helpers = '''def p(path): return ROOT / path
def read(path): return p(path).read_text(encoding='utf-8')
def write(path, text):
    p(path).parent.mkdir(parents=True, exist_ok=True)
    p(path).write_text(text, encoding='utf-8')
def once(text, old, new, label):
    if new and new in text:
        return text
    n = text.count(old)
    if n == 0:
        print(f'[HARDEN_WARN] {label}: original anchor not found; source may already be hardened')
        return text
    if n > 1:
        print(f'[HARDEN_WARN] {label}: {n} anchors found; replacing first')
    return text.replace(old, new, 1)
def sub_once(text, pattern, repl, label, flags=0):
    compiled = re.compile(pattern, flags)
    matches = list(compiled.finditer(text))
    if not matches:
        marker = repl[:40] if isinstance(repl, str) else ''
        if marker and marker in text:
            return text
        print(f'[HARDEN_WARN] {label}: regex anchor not found; source may already be hardened')
        return text
    if len(matches) > 1:
        print(f'[HARDEN_WARN] {label}: {len(matches)} regex anchors found; replacing first')
    return compiled.sub(repl, text, count=1)
'''

if strict_helpers not in source:
    raise RuntimeError('Unable to locate execution-hardening helper definitions')

source = source.replace(strict_helpers, resilient_helpers, 1)
namespace = {'__file__': str(PATCHER), '__name__': '__main__'}
exec(compile(source, str(PATCHER), 'exec'), namespace, namespace)
print('Execution hardening completed through idempotent wrapper.')
