import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '..');
const scannerEngine = fs.readFileSync(path.join(webRoot, 'lib', 'scannerEngine.js'), 'utf8');
const scannerCard = fs.readFileSync(path.join(webRoot, 'components', 'scanner-status-card.tsx'), 'utf8');

assert.match(scannerEngine, /signal === 'buy' \|\| signal === 'sell'/);
assert.match(scannerEngine, /signal === 'buy' \|\| signal === 'long'/);
assert.match(scannerCard, /const qualified = selectedEngine === 'v3'/);
assert.match(scannerCard, /const rejected = selectedEngine === 'v3'/);
assert.doesNotMatch(scannerCard, /const qualified = selectedEngine === 'ppr'/);

console.log('ICT dashboard result mapping verified.');
