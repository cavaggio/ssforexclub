import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('reassessment card renders one market decision and an always-available manual close button', () => {
  const source = readFileSync(new URL('../components/scanner-status-card.tsx', import.meta.url), 'utf8');

  assert.match(source, /Current market decision/);
  assert.match(source, /Institutional-flow read:/);
  assert.match(source, /Auto-close analysis:/);
  assert.match(source, /Close-review floor/);
  assert.match(source, /mode="close"/);
  assert.match(source, /manualCloseReason/);
});

test('reassessment card removes static multi-target and disabled-action presentation', () => {
  const source = readFileSync(new URL('../components/scanner-status-card.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('// ─── 30-min reassessment card');
  const end = source.indexOf('// ─── Section helpers');
  assert.ok(start >= 0 && end > start);
  const section = source.slice(start, end);

  assert.doesNotMatch(section, /Dynamic TP:/);
  assert.doesNotMatch(section, /Multi-target stage table/);
  assert.doesNotMatch(section, /DisabledActionButton/);
  assert.doesNotMatch(section, /classicTradeState/);
});
