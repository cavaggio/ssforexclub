import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(here, 'apply-ppr-scanner-ui.mjs');
let source = fs.readFileSync(target, 'utf8');

const oldBlock = `source = replaceOnce(
  source,
  "            <StatChip label=\"Rejected\" value={String(rejected.length)} />",
  "            <StatChip label=\"Rejected\" value={String(rejected.length)} />\\n" +
    "            <StatChip label=\"Active scanner\" value={selectedEngine.toUpperCase()} tone=\"good\" />",
  'active scanner chip',
);`;

const newBlock = `source = replaceOnce(
  source,
  "            <StatChip label=\"Rejected\" value={String(rejected.length)} />",
  "            <StatChip label=\"Rejected\" value={String(selectedEngine === 'ppr' ? nativeCounts.rejected : rejected.length)} />\\n" +
    "            <StatChip label=\"Active scanner\" value={selectedEngine.toUpperCase()} tone=\"good\" />\\n" +
    "            {selectedEngine === 'ppr' && (\\n" +
    "              <StatChip label=\"Auto AI\" value={pprAutoAiLabel} tone={pprReadiness?.liveReady ? 'good' : 'bad'} />\\n" +
    "            )}\\n" +
    "            {selectedEngine === 'ppr' && (\\n" +
    "              <StatChip label=\"Count check\" value={nativeCounts.invariantOk && nativeCounts.scanned === nativeCounts.accounted ? 'OK' : 'MISMATCH'} tone={nativeCounts.invariantOk && nativeCounts.scanned === nativeCounts.accounted ? 'good' : 'bad'} />\\n" +
    "            )}",
  'active scanner and PPR readiness chips',
);`;

if (!source.includes(newBlock)) {
  if (!source.includes(oldBlock)) {
    throw new Error('PPR scanner UI generator marker missing: active scanner chip block');
  }
  source = source.replace(oldBlock, newBlock);
}

fs.writeFileSync(target, source);
console.log('PPR scanner UI generator prepared for count and live-readiness chips.');
