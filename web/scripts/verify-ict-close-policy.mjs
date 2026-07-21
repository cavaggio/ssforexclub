import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const routePath = resolve(process.cwd(), 'app/api/cron/active-trade-management/route.ts');
const source = readFileSync(routePath, 'utf8');

for (const marker of [
  'ICT_MIN_REASSESSMENT_AGE_MINUTES = 30',
  'ICT_NEAR_SL_RISK_FRACTION = 0.25',
  'explicitHighReversal',
  'explicitCloseRecommendation',
  'closeToStop',
  'ict_30m_high_reversal_near_sl_only',
  "tradeEngine === 'ict'",
]) {
  if (!source.includes(marker)) {
    throw new Error(`ICT close-policy verification failed: missing ${marker}`);
  }
}

const ictPolicyStart = source.indexOf('export function shouldCloseIctTrade');
const v3PolicyStart = source.indexOf('// Preserve the existing V3 management policy');
if (ictPolicyStart < 0 || v3PolicyStart <= ictPolicyStart) {
  throw new Error('ICT close-policy verification failed: policy boundaries missing');
}

const ictPolicy = source.slice(ictPolicyStart, v3PolicyStart);
for (const forbidden of ['EXIT_REVIEW', 'confidence_breakdown', 'mediumOrHigherReversal', 'volatilityCollapsed']) {
  if (ictPolicy.includes(forbidden)) {
    throw new Error(`ICT close-policy verification failed: forbidden broad trigger ${forbidden}`);
  }
}

console.log('ICT close policy verified: 30m + HIGH reversal + explicit exit + near-SL only');
