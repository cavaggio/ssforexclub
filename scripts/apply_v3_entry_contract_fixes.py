#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path):
    return (ROOT / path).read_text(encoding='utf-8')


def write(path, text):
    (ROOT / path).write_text(text, encoding='utf-8')


path = 'server/v3EntryContract.js'
text = read(path)
old = """function eventTimestamp(event = {}) {
  const raw = event.time || event.timestamp || event.candleTime || event.detectedAt || null;
  const ms = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(ms) ? ms : null;
}
"""
new = """function eventTimestamp(event = {}) {
  if (!event || typeof event !== 'object') return null;
  const raw = event.time || event.timestamp || event.candleTime || event.detectedAt || null;
  const ms = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(ms) ? ms : null;
}
"""
if new not in text:
    if text.count(old) != 1:
        raise RuntimeError('eventTimestamp null guard anchor not found')
    text = text.replace(old, new, 1)
write(path, text)

print('V3 entry contract follow-up fixes applied.')
