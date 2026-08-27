import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  patchIctRejectionDiagnostics,
  patchSchedulerWindowDiagnostic,
} from './apply_scan_rejection_diagnostics.mjs';

const ictSource = readFileSync(new URL('../server/ictEngine.js', import.meta.url), 'utf8');
const schedulerSource = readFileSync(new URL('../server/ictAutoScheduler.js', import.meta.url), 'utf8');

test('ICT scan logs expose every exact rejection reason without oversized payloads', () => {
  const patched = patchIctRejectionDiagnostics(ictSource);
  assert.match(patched, /\[ICT_REJECT_REASON\]/);
  assert.match(patched, /conf=\$\{confidence\} rr=\$\{scanRR\}/);
  assert.match(patched, /killzone=\$\{kz\.inKillzone\}/);
  assert.match(patched, /liquidity=\$\{sweepAligned \|\| drawPresent\}/);
  assert.match(patched, /entryTrigger=\$\{entryTrigger\}/);
  assert.match(patched, /for \(const reason of rejectionReasons\)/);
  assert.equal(patchIctRejectionDiagnostics(patched), patched);
});

test('scheduler diagnostic keeps morning study, 17:30 review, and 02:30–10:30 live window', () => {
  const patched = patchSchedulerWindowDiagnostic(schedulerSource);
  assert.match(patched, /morningStudy=02:00_ET/);
  assert.match(patched, /endOfDayReview=17:30_ET/);
  assert.match(patched, /scans=02:30–10:30_ET/);
  assert.match(patched, /entries=02:30–10:30_ET/);
  assert.doesNotMatch(patched, /PPR_03:00\/ICT_05:00/);
  assert.equal(patchSchedulerWindowDiagnostic(patched), patched);
});
