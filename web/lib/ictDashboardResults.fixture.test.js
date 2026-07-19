import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeSelectedScan } from './scannerEngine.js';

test('production-shaped ICT fixture produces 12 visible rows', () => {
  const fixture = JSON.parse(readFileSync(new URL('./ictDashboardResults.fixture.json', import.meta.url), 'utf8'));
  const scan = normalizeSelectedScan('ict', fixture);
  assert.equal(scan.qualified.length + scan.rejected.length, 12);
  assert.deepEqual(scan.qualified.map((item) => item.direction), ['long', 'short']);
});
