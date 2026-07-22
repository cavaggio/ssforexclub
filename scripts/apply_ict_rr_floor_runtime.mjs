import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = resolve(ROOT, 'server/ictEngine.js');

const POLICY_BLOCK = [
  '// Signal Stack policy: R:R is a ratio, not a percentage. Every generated ICT',
  '// setup is constructed at a minimum of 1:1.5 before qualification/execution.',
  'export const ICT_MIN_RR = 1.5;',
  'export function configuredIctMinRR() {',
  "  const configured = parseFloat(process.env.ICT_MIN_RR || '1.5');",
  '  return Number.isFinite(configured) ? Math.max(ICT_MIN_RR, configured) : ICT_MIN_RR;',
  '}',
  '',
  '/**',
  ' * Extend a technically valid target to the configured minimum R:R when the',
  ' * nearest liquidity target is too close. This changes take-profit only; the',
  ' * structure-derived entry and stop remain authoritative.',
  ' */',
  'export function enforceMinimumRRTarget({ pair, direction, entry, stopLoss, target, minRR = configuredIctMinRR() }) {',
  "  const bull = direction === 'long' || direction === 'bullish' || direction === 'buy';",
  "  const bear = direction === 'short' || direction === 'bearish' || direction === 'sell';",
  '  const entryPrice = Number(entry);',
  '  const stopPrice = Number(stopLoss);',
  '  const rawTarget = Number(target);',
  '  const floor = Number(minRR);',
  '',
  "  if (!bull && !bear) return { ok: false, reason: 'Invalid trade direction for R:R target construction.' };",
  '  if (![entryPrice, stopPrice, rawTarget, floor].every(Number.isFinite) || floor < ICT_MIN_RR) {',
  "    return { ok: false, reason: 'Invalid price or minimum R:R input.' };",
  '  }',
  '',
  '  const geometryOK = bull',
  '    ? stopPrice < entryPrice && rawTarget > entryPrice',
  '    : stopPrice > entryPrice && rawTarget < entryPrice;',
  "  if (!geometryOK) return { ok: false, reason: 'Invalid entry/stop/target geometry.' };",
  '',
  '  const risk = Math.abs(entryPrice - stopPrice);',
  "  if (risk <= 0) return { ok: false, reason: 'Degenerate stop distance.' };",
  '',
  '  const minimumTarget = bull',
  '    ? entryPrice + (risk * floor)',
  '    : entryPrice - (risk * floor);',
  '  const selectedTarget = bull',
  '    ? Math.max(rawTarget, minimumTarget)',
  '    : Math.min(rawTarget, minimumTarget);',
  '',
  '  const tick = 10 ** (-pricePrecision(pair));',
  '  let adjustedTarget = roundPrice(selectedTarget, pair);',
  '  let reward = Math.abs(adjustedTarget - entryPrice);',
  '',
  '  // Rounding can place the target one tick inside the floor. Step outward until',
  '  // the executable, rounded price is truly at or above the minimum R:R.',
  '  let safety = 0;',
  '  while ((reward / risk) < (floor - 1e-9) && safety < 3) {',
  '    adjustedTarget = roundPrice(adjustedTarget + (bull ? tick : -tick), pair);',
  '    reward = Math.abs(adjustedTarget - entryPrice);',
  '    safety += 1;',
  '  }',
  '',
  '  const rr = +(reward / risk).toFixed(2);',
  '  if (rr < floor) return { ok: false, reason: `Could not construct minimum ${floor.toFixed(1)}R target after rounding.` };',
  '',
  '  return {',
  '    ok: true,',
  '    target: adjustedTarget,',
  '    rr,',
  '    risk,',
  '    reward,',
  '    minimumTarget,',
  '    rawTarget,',
  '    adjusted: bull ? rawTarget < minimumTarget : rawTarget > minimumTarget,',
  '  };',
  '}',
].join('\n');

const OLD_SETUP_BLOCK = [
  '  const risk = Math.abs(entry - stopLoss);',
  '  const reward = Math.abs(targetPool.price - entry);',
  "  if (risk <= 0) return { ok: false, reason: 'Degenerate stop distance.' };",
  '  const rr = +(reward / risk).toFixed(2);',
  '',
  '  return {',
  '    ok: true,',
  '    entrySource,',
  '    entry,',
  '    stopLoss,',
  '    target1: targetPool.price,',
  '    target1Label: targetPool.label,',
  '    target2: target2Pool ? target2Pool.price : null,',
  '    target2Label: target2Pool ? target2Pool.label : null,',
  '    rr,',
  '    riskPips: toPips(risk, pair),',
  '    rewardPips: toPips(reward, pair),',
  '  };',
].join('\n');

const NEW_SETUP_BLOCK = [
  '  const targetPolicy = enforceMinimumRRTarget({',
  '    pair,',
  '    direction: dir,',
  '    entry,',
  '    stopLoss,',
  '    target: targetPool.price,',
  '    minRR: configuredIctMinRR(),',
  '  });',
  '  if (!targetPolicy.ok) return targetPolicy;',
  '',
  '  const {',
  '    target: target1,',
  '    rr,',
  '    risk,',
  '    reward,',
  '    rawTarget: rawLiquidityTarget,',
  '    adjusted: targetAdjustedToMinRR,',
  '  } = targetPolicy;',
  '',
  '  const target2Price = target2Pool ? Number(target2Pool.price) : null;',
  '  const target2IsBeyondTarget1 = Number.isFinite(target2Price) && (',
  '    bull ? target2Price > target1 : target2Price < target1',
  '  );',
  '',
  '  return {',
  '    ok: true,',
  '    entrySource,',
  '    entry,',
  '    stopLoss,',
  '    target1,',
  '    target1Label: targetAdjustedToMinRR',
  '      ? `${targetPool.label} (extended to ${configuredIctMinRR().toFixed(1)}R minimum)`',
  '      : targetPool.label,',
  '    target2: target2IsBeyondTarget1 ? target2Price : null,',
  '    target2Label: target2IsBeyondTarget1 ? target2Pool.label : null,',
  '    rr,',
  '    riskPips: toPips(risk, pair),',
  '    rewardPips: toPips(reward, pair),',
  '    rawLiquidityTarget,',
  '    targetAdjustedToMinRR,',
  '    minimumRR: configuredIctMinRR(),',
  '  };',
].join('\n');

function replaceOneOf(source, oldValues, replacement, label) {
  if (source.includes(replacement)) return source;
  const matches = oldValues.filter((candidate) => source.includes(candidate));
  if (matches.length !== 1) {
    throw new Error(`ICT R:R runtime marker missing/ambiguous: ${label} (${matches.length} matches)`);
  }
  return source.replace(matches[0], replacement);
}

export function applyIctRrFloorRuntime() {
  let source = readFileSync(ENGINE, 'utf8');
  const before = source;

  source = replaceOneOf(
    source,
    ["import { getPipSize, toPips, roundPrice } from './pipMath.js';"],
    "import { getPipSize, pricePrecision, toPips, roundPrice } from './pipMath.js';",
    'pricePrecision import',
  );

  if (!source.includes('export function enforceMinimumRRTarget')) {
    const anchor = /export function isIctEnabled\(\) \{[^\n]+\}\n/;
    const match = source.match(anchor);
    if (!match) throw new Error('ICT R:R runtime marker missing: isIctEnabled anchor');
    source = source.replace(match[0], `${match[0]}\n${POLICY_BLOCK}\n`);
  }

  source = replaceOneOf(
    source,
    [
      "    minRR: parseFloat(process.env.ICT_MIN_RR || '2.0'),",
      "    minRR: parseFloat(process.env.ICT_MIN_RR || '1.5'),",
      "    minRR: Math.max(1.5, parseFloat(process.env.ICT_MIN_RR || '1.5')),",
      '    minRR: ICT_MIN_RR,',
    ],
    '    minRR: configuredIctMinRR(),',
    'execution config minimum R:R',
  );

  source = source.replace(
    /const MIN_RR = (?:Math\.max\(1\.5,\s*)?parseFloat\(process\.env\.ICT_MIN_RR \|\| '(?:1|1\.0|1\.5|2|2\.0)'\)\)?;\n\n/,
    '',
  );
  source = source.replace('const MIN_RR = ICT_MIN_RR;\n\n', '');

  if (!source.includes(NEW_SETUP_BLOCK)) {
    if (!source.includes(OLD_SETUP_BLOCK)) {
      throw new Error('ICT R:R runtime marker missing: computeSetup risk/reward block');
    }
    source = source.replace(OLD_SETUP_BLOCK, NEW_SETUP_BLOCK);
  }

  source = source.replace(
    '  void MIN_RR; void pendingSweepDir; // RR is enforced for auto-execution (executor), not display',
    '  void pendingSweepDir; // Minimum R:R is already constructed into setup.target1.',
  );

  const required = [
    'pricePrecision, toPips, roundPrice',
    'export const ICT_MIN_RR = 1.5;',
    "parseFloat(process.env.ICT_MIN_RR || '1.5')",
    'minRR: configuredIctMinRR()',
    'export function enforceMinimumRRTarget',
    'const targetPolicy = enforceMinimumRRTarget({',
    'targetAdjustedToMinRR',
    'minimumRR: configuredIctMinRR()',
    'void pendingSweepDir; // Minimum R:R is already constructed into setup.target1.',
  ];
  const missing = required.filter((marker) => !source.includes(marker));
  const forbidden = [
    'const MIN_RR =',
    'const reward = Math.abs(targetPool.price - entry);',
    'target1: targetPool.price,',
    'void MIN_RR;',
  ].filter((marker) => source.includes(marker));

  if (missing.length || forbidden.length) {
    throw new Error(
      `ICT R:R runtime enforcement incomplete` +
      `${missing.length ? `; missing=${missing.join('|')}` : ''}` +
      `${forbidden.length ? `; forbidden=${forbidden.join('|')}` : ''}`,
    );
  }

  if (source !== before) writeFileSync(ENGINE, source, 'utf8');
  console.log(`[RUNTIME_EXECUTION_START] ICT R:R floor verified${source !== before ? ' (patched)' : ''}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  applyIctRrFloorRuntime();
}
