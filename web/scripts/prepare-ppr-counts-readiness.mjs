import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(here, '..', 'components', 'scanner-status-card.tsx');
let source = fs.readFileSync(target, 'utf8');

// The authoritative scanner UI generator expects its own base summary-chip block
// on every pass. Restore that base block before it runs; the final count/readiness
// pass will then reapply the PPR-specific chips. This makes two consecutive full
// generation passes produce byte-identical final source.
source = source.replace(
  "            <StatChip label=\"Qualified\" value={String(selectedEngine === 'ppr' ? nativeCounts.qualified : qualified.length)} tone=\"good\" />\n" +
    "            {selectedEngine === 'ppr' && <StatChip label=\"Watching\" value={String(nativeCounts.watching)} />}",
  '            <StatChip label="Qualified" value={String(qualified.length)} tone="good" />',
);

source = source.replace(
  "            <StatChip label=\"Rejected\" value={String(selectedEngine === 'ppr' ? nativeCounts.rejected : rejected.length)} />",
  '            <StatChip label="Rejected" value={String(rejected.length)} />',
);

source = source.replace(
  "            <StatChip label=\"Active scanner\" value={selectedEngine.toUpperCase()} tone=\"good\" />\n" +
    "            {selectedEngine === 'ppr' && (\n" +
    "              <StatChip label=\"Auto AI\" value={pprAutoAiLabel} tone={pprReadiness?.liveReady ? 'good' : 'bad'} />\n" +
    "            )}\n" +
    "            {selectedEngine === 'ppr' && (\n" +
    "              <StatChip label=\"Count check\" value={nativeCounts.invariantOk && nativeCounts.scanned === nativeCounts.accounted ? 'OK' : 'MISMATCH'} tone={nativeCounts.invariantOk && nativeCounts.scanned === nativeCounts.accounted ? 'good' : 'bad'} />\n" +
    "            )}",
  '            <StatChip label="Active scanner" value={selectedEngine.toUpperCase()} tone="good" />',
);

fs.writeFileSync(target, source);
console.log('PPR summary chips reset for the authoritative scanner UI pass.');
