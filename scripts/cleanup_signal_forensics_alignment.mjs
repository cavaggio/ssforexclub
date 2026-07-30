import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const path = resolve(ROOT, 'server/ictAutoTrade.js');
const before = readFileSync(path, 'utf8');
let after = before;

const qualifiedStart = after.indexOf('export function isIctAutoQualified');
const duplicateStart = qualifiedStart >= 0
  ? after.indexOf('function buildIctWatchState(', qualifiedStart)
  : -1;
const runStart = duplicateStart >= 0
  ? after.indexOf('export async function runAutoAiForUser', duplicateStart)
  : -1;

if (duplicateStart >= 0 && runStart > duplicateStart) {
  after = `${after.slice(0, duplicateStart)}${after.slice(runStart)}`;
}

const occurrences = (after.match(/(?:export\s+)?function buildIctWatchState\(/g) || []).length;
if (occurrences !== 1) {
  throw new Error(`Expected exactly one ICT watch-state implementation after cleanup; found ${occurrences}`);
}
if (!after.includes('export function buildIctWatchState')) {
  throw new Error('Authoritative exported ICT watch-state implementation is missing');
}
if (!after.includes('buildIctWatchState(analyses, cfg.minConfidence, cfg.minRR)')) {
  throw new Error('ICT runner is not using the authoritative watch-state contract');
}

if (after !== before) writeFileSync(path, after, 'utf8');
console.log(`[SIGNAL_FORENSICS] legacy ICT watch-state implementation removed${after !== before ? ' (patched)' : ''}`);

// The legacy execution-first pass validates the temporary v2 model marker.
// Normalize only that marker here; the final quality-separation pass restores
// the committed v3 signal/execution model after all legacy generators finish.
const targetConfidencePath = resolve(ROOT, 'server/ictTargetConfidence.js');
const targetBefore = readFileSync(targetConfidencePath, 'utf8');
const targetPrepared = targetBefore.replace(
  "model: 'ict_signal_execution_quality_v3'",
  "model: 'ict_current_executable_scalp_v2'",
);
if (targetPrepared !== targetBefore) writeFileSync(targetConfidencePath, targetPrepared, 'utf8');
console.log(`[SIGNAL_FORENSICS] ICT confidence compatibility marker prepared${targetPrepared !== targetBefore ? ' (patched)' : ''}`);

await import('./apply_execution_first_policy.mjs');
