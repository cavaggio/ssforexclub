#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MONITOR = path.join(ROOT, 'server', 'oandaActiveTradeMonitor.js');

let source = fs.readFileSync(MONITOR, 'utf8');
const fields = `    entryIctConfidence,
    expectedHoldTimeMinutes,
    ictLifecycle,
`;
const duplicate = fields + fields;
while (source.includes(duplicate)) source = source.replace(duplicate, fields);

const expected = `    liveTpConfidence: liveV3Confidence,
${fields}`;
if (!source.includes(expected)) {
  throw new Error('ICT confidence dedupe marker missing from active-trade monitor.');
}

fs.writeFileSync(MONITOR, source);
console.log('ICT confidence alignment deduplicated and synchronized.');
