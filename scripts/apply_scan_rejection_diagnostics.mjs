import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function replaceRequired(source, before, after, label) {
  if (source.includes(after)) return source;
  if (!source.includes(before)) throw new Error(`[SCAN_REJECTION_DIAGNOSTICS] missing ${label}`);
  return source.replace(before, after);
}

export function patchIctRejectionDiagnostics(source) {
  if (source.includes('[ICT_REJECT_REASON]')) return source;

  const before = `  // Spec logging: ICT mode, auto-trade, independence, Daily/4H bias, 5M confirmation.
  console.log(
    \`[ICT] \${pair} mode=\${ICT_MODE} autoTrade=\${ictExecConfig().autoTradeEnabled} independentFromV3=true | \` +
    \`dailyBias=\${dailyTfBias} h4Bias=\${h4TfBias} aligned=\${htfAligned} | \` +
    \`5M=\${signal !== 'none' ? 'confirmed' : 'none'} signal=\${signal}\${news.blocked ? ' [NEWS-BLOCK]' : news.caution ? ' [news-caution]' : ''}\`,
  );
`;

  const after = `  // Scan-log contract: emit a compact candidate summary and one separate line
  // for every rejection. Railway truncates long messages, so reasons must never
  // be hidden inside one oversized JSON or collapsed to only "5M=none".
  const scanRR = setup?.ok && Number.isFinite(Number(setup.rr)) ? Number(setup.rr).toFixed(2) : 'n/a';
  console.log(
    \`[ICT] \${pair} mode=\${ICT_MODE} autoTrade=\${ictExecConfig().autoTradeEnabled} independentFromV3=true | \` +
    \`dailyBias=\${dailyTfBias} h4Bias=\${h4TfBias} aligned=\${htfAligned} | \` +
    \`5M=\${signal !== 'none' ? 'confirmed' : 'none'} signal=\${signal} conf=\${confidence} rr=\${scanRR} \` +
    \`killzone=\${kz.inKillzone} liquidity=\${sweepAligned || drawPresent} entryTrigger=\${entryTrigger}\` +
    \`\${news.blocked ? ' [NEWS-BLOCK]' : news.caution ? ' [news-caution]' : ''}\`,
  );
  if (signal === 'none') {
    if (!rejectionReasons.length) {
      console.log(\`[ICT_REJECT_REASON] pair=\${pair} reason="unknown scanner rejection"\`);
    }
    for (const reason of rejectionReasons) {
      console.log(\`[ICT_REJECT_REASON] pair=\${pair} reason=\${JSON.stringify(String(reason))}\`);
    }
  }
`;

  const out = replaceRequired(source, before, after, 'ICT console logging block');
  const required = [
    '[ICT_REJECT_REASON]',
    'entryTrigger=${entryTrigger}',
    'liquidity=${sweepAligned || drawPresent}',
    'conf=${confidence} rr=${scanRR}',
  ];
  const missing = required.filter((marker) => !out.includes(marker));
  if (missing.length) throw new Error(`[SCAN_REJECTION_DIAGNOSTICS] ICT markers missing: ${missing.join(', ')}`);
  return out;
}

export function patchSchedulerWindowDiagnostic(source) {
  const stale = '[AUTO_AI] scans=02:00–10:00_ET entries=V3_02:15/PPR_03:00/ICT_05:00 weekdays_only ';
  const accurate = '[AUTO_AI] study=02:00_ET scans=02:00–10:00_ET entries=02:30–10:00_ET weekdays_only ';
  if (source.includes(accurate)) return source;
  const oldUnified = '[AUTO_AI] scans=02:00–10:00_ET entries=V3/PPR/ICT_02:15 weekdays_only ';
  if (source.includes(oldUnified)) return source.replace(oldUnified, accurate);
  return replaceRequired(source, stale, accurate, 'scheduler execution-window diagnostic');
}

export function applyScanRejectionDiagnostics(root = DEFAULT_ROOT) {
  const targets = [
    ['server/ictEngine.js', patchIctRejectionDiagnostics],
    ['server/ictAutoScheduler.js', patchSchedulerWindowDiagnostic],
  ];
  const changed = [];

  for (const [relativePath, patcher] of targets) {
    const path = resolve(root, relativePath);
    if (!existsSync(path)) continue;
    const before = readFileSync(path, 'utf8');
    const after = patcher(before);
    if (after !== before) {
      writeFileSync(path, after, 'utf8');
      changed.push(relativePath);
    }
    console.log(`[SCAN_REJECTION_DIAGNOSTICS] verified ${relativePath}${after !== before ? ' (patched)' : ''}`);
  }

  return changed;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  applyScanRejectionDiagnostics();
}
