import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(here, '..', 'components', 'scanner-status-card.tsx');

function replaceOnce(source, oldText, newText, label) {
  if (source.includes(newText)) return source;
  if (!source.includes(oldText)) throw new Error(`ICT scanner result marker missing: ${label}`);
  return source.replace(oldText, newText);
}

let source = fs.readFileSync(target, 'utf8');

source = replaceOnce(
  source,
  `  const qualified = selectedEngine === 'ppr'
    ? qualifiedRaw
    : qualifiedRaw.filter((sig: any) => !isSubMinRrDisplay(sig));
  const rejected = selectedEngine === 'ppr'
    ? rejectedRaw
    : rejectedRaw.filter((sig: any) => !isSubMinRrDisplay(sig));`,
  `  // The 1.5R display guard belongs only to V3 executable cards. ICT and PPR
  // must retain every native result, including below-floor rejection diagnostics.
  const qualified = selectedEngine === 'v3'
    ? qualifiedRaw.filter((sig: any) => !isSubMinRrDisplay(sig))
    : qualifiedRaw;
  const rejected = selectedEngine === 'v3'
    ? rejectedRaw.filter((sig: any) => !isSubMinRrDisplay(sig))
    : rejectedRaw;`,
  'engine-specific R:R display filtering',
);

for (const marker of [
  "const qualified = selectedEngine === 'v3'",
  "const rejected = selectedEngine === 'v3'",
  'including below-floor rejection diagnostics',
  'NativeEngineScanPanel',
]) {
  if (!source.includes(marker)) throw new Error(`ICT scanner result fix incomplete: ${marker}`);
}

fs.writeFileSync(target, source);
console.log('ICT native scanner results preserved in dashboard.');
