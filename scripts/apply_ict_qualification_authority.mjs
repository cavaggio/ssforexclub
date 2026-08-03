import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function replaceRequired(source, before, after, label) {
  if (source.includes(after)) return source;
  if (!source.includes(before)) throw new Error(`[ICT_QUALIFICATION_AUTHORITY] missing ${label}`);
  return source.replace(before, after);
}

export function patchIctQualificationAuthority(source) {
  let out = source;

  // A setup that the ICT scanner has already qualified must not be vetoed by the
  // separate scalp-only classifier. The lifecycle engine can still manage the
  // hold duration after fill, while every broker/risk/price guard remains active.
  out = replaceRequired(
    out,
    `  if (isExplicitSwingSignal(analysis)) {
    return blocked('Scalp-only execution: ICT swing trade signals are disabled.');
  }
`,
    `  if (isExplicitSwingSignal(analysis)) {
    analysis = { ...analysis, executionTradeStyle: 'SWING', scannerQualifiedSwing: true };
    rec(\`scanner-qualified ICT swing accepted for \${pair}; lifecycle management remains active\`);
  }
`,
    'qualified swing execution policy',
  );

  // evaluateUniversalEntryPolicy contains V3 sweep/retest rules. Applying it to
  // an ICT Turtle Soup or liquidity-raid reversal can incorrectly reinterpret
  // the expected opposing sweep as a veto. ICT qualification is authoritative;
  // generic safety guards are enforced separately below.
  const priorUniversalPolicy = `  const universalPolicy = usedQualifiedSnapshotGrace
    ? { allowed: true, reasons: [] }
    : evaluateUniversalEntryPolicy({ ...analysis, pair, direction });
  if (!universalPolicy.allowed) return blocked(\`Universal entry policy: \${universalPolicy.reasons.join('; ')}\`);
`;
  const baseUniversalPolicy = `  const universalPolicy = evaluateUniversalEntryPolicy({ ...analysis, pair, direction });
  if (!universalPolicy.allowed) return blocked(\`Universal entry policy: \${universalPolicy.reasons.join('; ')}\`);
`;
  const ictUniversalPolicy = `  const universalPolicy = {
    allowed: true,
    reasons: [],
    ictScannerAuthoritative: true,
  };
`;
  if (!out.includes(ictUniversalPolicy)) {
    if (out.includes(priorUniversalPolicy)) out = out.replace(priorUniversalPolicy, ictUniversalPolicy);
    else out = replaceRequired(out, baseUniversalPolicy, ictUniversalPolicy, 'ICT-only universal policy bypass');
  }

  // Claude stop advice is optional enhancement, never a reason to reject an
  // otherwise-qualified setup. If widening would break the R:R floor, retain the
  // scanner's structural stop and continue with the original qualified geometry.
  const oldAdvisorGeometry = `  const executionRisk = Math.abs(entry - stopLoss);
  const executionReward = Math.abs(targetProfit - entry);
  const executionRR = executionRisk > 0 ? +(executionReward / executionRisk).toFixed(2) : 0;
  if (executionRR < config.minRR) return blocked(\`Advisor/volatility stop would reduce RR below \${config.minRR} (\${executionRR}).\`);
`;
  const newAdvisorGeometry = `  let executionRisk = Math.abs(entry - stopLoss);
  let executionReward = Math.abs(targetProfit - entry);
  let executionRR = executionRisk > 0 ? +(executionReward / executionRisk).toFixed(2) : 0;
  if (executionRR < config.minRR && boundedStop.adjusted) {
    stopLoss = authoritativeStop;
    executionRisk = Math.abs(entry - stopLoss);
    executionReward = Math.abs(targetProfit - entry);
    executionRR = executionRisk > 0 ? +(executionReward / executionRisk).toFixed(2) : 0;
    rec(
      \`optional stop advice ignored for \${pair}; scanner stop retained to preserve \` +
      \`\${config.minRR.toFixed(2)}R (restored \${executionRR.toFixed(2)}R)\`,
    );
  }
  if (executionRR < config.minRR) {
    return blocked(\`Final ICT geometry is below \${config.minRR}R after restoring the scanner stop (\${executionRR}).\`);
  }
`;
  out = replaceRequired(out, oldAdvisorGeometry, newAdvisorGeometry, 'optional stop-advice fallback');

  const required = [
    'scannerQualifiedSwing: true',
    'ictScannerAuthoritative: true',
    'optional stop advice ignored for ${pair}',
    'stopLoss = authoritativeStop;',
  ];
  const missing = required.filter((marker) => !out.includes(marker));
  if (missing.length) {
    throw new Error(`[ICT_QUALIFICATION_AUTHORITY] execution markers missing: ${missing.join(', ')}`);
  }
  return out;
}

export function applyIctQualificationAuthority(root = DEFAULT_ROOT) {
  const path = resolve(root, 'server/ictExecution.js');
  if (!existsSync(path)) return [];
  const before = readFileSync(path, 'utf8');
  const after = patchIctQualificationAuthority(before);
  if (after !== before) writeFileSync(path, after, 'utf8');
  console.log(`[ICT_QUALIFICATION_AUTHORITY] verified server/ictExecution.js${after !== before ? ' (patched)' : ''}`);
  return after !== before ? ['server/ictExecution.js'] : [];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  applyIctQualificationAuthority();
}
