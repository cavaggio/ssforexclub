import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '..');

function update(relativePath, transform) {
  const filePath = path.resolve(webRoot, relativePath);
  const original = fs.readFileSync(filePath, 'utf8');
  const next = transform(original);
  fs.writeFileSync(filePath, next);
}

function replaceOnce(source, oldText, newText, label) {
  if (source.includes(newText)) return source;
  if (!source.includes(oldText)) throw new Error(`PPR pending-confidence marker missing: ${label}`);
  return source.replace(oldText, newText);
}

update('lib/scannerEngine.js', (input) => replaceOnce(
  input,
  `function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}`,
  `function numberOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}`,
  'null-safe scanner number normalization',
));

update('components/native-engine-scan-panel.tsx', (input) => {
  let source = input;
  source = replaceOnce(
    source,
    `  const rr = num(item?.rr ?? item?.expectedRR);
  const volumeRatio = num(volume?.ratio ?? confirmation?.volumeRatio);`,
    `  const rr = num(item?.rr ?? item?.expectedRR);
  const confidence = num(item?.confidence);
  const confidenceLabel = confidence === null
    ? status === 'qualified' ? '—' : 'PENDING'
    : \`${'${confidence}'}%\`;
  const volumeRatio = num(volume?.ratio ?? confirmation?.volumeRatio);`,
    'PPR pending confidence label',
  );
  source = replaceOnce(
    source,
    `<div style={{ fontSize: 21, fontWeight: 850 }}>{num(item?.confidence) !== null ? \`${'${num(item?.confidence)}'}%\` : '—'}</div>`,
    `<div style={{ fontSize: 21, fontWeight: 850 }}>{confidenceLabel}</div>`,
    'PPR confidence rendering',
  );
  return source;
});

console.log('PPR pending confidence now renders as PENDING instead of 0%.');
