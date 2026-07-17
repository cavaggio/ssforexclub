import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(here, '..', 'components', 'scanner-status-card.tsx');

function replaceOnce(source, oldText, newText, label) {
  if (source.includes(newText)) return source;
  if (!source.includes(oldText)) throw new Error(`PPR watch-candidate marker missing: ${label}`);
  return source.replace(oldText, newText);
}

let source = fs.readFileSync(target, 'utf8');
source = replaceOnce(
  source,
  "      const rejectedSafe = Array.isArray(scan.rejected)\n        ? scan.rejected.slice(0, 20).map((s: any) => compactSignalPayload(s))\n        : [];",
  "      const rejectedSafe = Array.isArray(scan.rejected)\n        ? scan.rejected.slice(0, 20).map((s: any) => compactSignalPayload(s))\n        : [];\n" +
    "      const watchCandidatesSafe = Array.isArray((scan as any).watchCandidates)\n" +
    "        ? (scan as any).watchCandidates.slice(0, 20).map((s: any) => compactSignalPayload(s))\n" +
    "        : [];",
  'watch candidate normalization',
);
source = replaceOnce(
  source,
  "        scan: {\n          qualified: qualifiedSafe,\n          rejected: rejectedSafe,\n          meta: scan.meta ?? ({} as ForexScanResult['meta']),\n        },",
  "        scan: {\n          qualified: qualifiedSafe,\n          rejected: rejectedSafe,\n          watchCandidates: watchCandidatesSafe,\n          meta: scan.meta ?? ({} as ForexScanResult['meta']),\n        } as ForexScanResult & { watchCandidates: any[] },",
  'watch candidates in state',
);

fs.writeFileSync(target, source);
console.log('Native scanner watch candidates preserved.');
