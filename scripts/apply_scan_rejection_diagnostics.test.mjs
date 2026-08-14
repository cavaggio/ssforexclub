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

test('scheduler diagnostic matches the 02:00 study and 02:30 entry windows', () => {
  const patched = patchSchedulerWindowDiagnostic(schedulerSource);
  assert.match(patched, /study=02:00_ET/);
  assert.match(patched, /entries=02:30–10:00_ET/);
  assert.doesNotMatch(patched, /PPR_03:00\/ICT_05:00/);
  assert.equal(patchSchedulerWindowDiagnostic(patched), patched);
});
