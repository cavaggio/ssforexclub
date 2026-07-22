import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function patchFile(relativePath, patcher, markers) {
  const path = resolve(ROOT, relativePath);
  const before = readFileSync(path, 'utf8');
  const after = patcher(before);
  const missing = markers.filter((marker) => !after.includes(marker));
  if (missing.length) throw new Error(`${relativePath} missing durable-risk markers: ${missing.join(', ')}`);
  if (after !== before) writeFileSync(path, after, 'utf8');
  console.log(`[DAILY_RISK_PERSISTENCE] verified ${relativePath}${after !== before ? ' (patched)' : ''}`);
}

patchFile(
  'server/ictExecution.js',
  (source) => {
    let out = source;
    if (!out.includes('hydrateDailyRiskState,')) {
      out = out.replace(
        '  checkDailyRiskLock,\n',
        '  checkDailyRiskLock,\n  hydrateDailyRiskState,\n  persistDailyRiskState,\n',
      );
    }
    if (!out.includes('await hydrateDailyRiskState({ accountId: riskAccountId, balanceUSD, now });')) {
      out = out.replace(
        "  if (!balanceUSD || Number.isNaN(balanceUSD)) return blocked('Account balance is 0 — fund account before live trading.');\n\n  // ── 8a. Daily drawdown circuit breaker",
        "  if (!balanceUSD || Number.isNaN(balanceUSD)) return blocked('Account balance is 0 — fund account before live trading.');\n  const riskAccountId =\n    client?.accountId || client?.accountID || client?.account_id ||\n    client?.config?.accountId || client?.defaults?.accountId;\n  await hydrateDailyRiskState({ accountId: riskAccountId, balanceUSD, now });\n  await persistDailyRiskState({ accountId: riskAccountId, balanceUSD, now });\n\n  // ── 8a. Daily drawdown circuit breaker",
      );
    }
    if (!out.includes('await persistDailyRiskState({ accountId: riskAccountId, balanceUSD, now });')) {
      out = out.replace(
        '  await hydrateDailyRiskState({ accountId: riskAccountId, balanceUSD, now });\n',
        '  await hydrateDailyRiskState({ accountId: riskAccountId, balanceUSD, now });\n  await persistDailyRiskState({ accountId: riskAccountId, balanceUSD, now });\n',
      );
    }
    out = out
      .replace('checkDailyRiskLock({ accountId: client.accountId, balanceUSD, now })', 'checkDailyRiskLock({ accountId: riskAccountId, balanceUSD, now })')
      .replace('reserveDailyLossBudget({ accountId: client.accountId, balanceUSD,', 'reserveDailyLossBudget({ accountId: riskAccountId, balanceUSD,');
    if (!out.includes('await persistDailyRiskState({ accountId, balanceUSD, now });')) {
      out = out.replace(
        '  markTradeOpened({ accountId, balanceUSD, now });\n',
        '  markTradeOpened({ accountId, balanceUSD, now });\n  await persistDailyRiskState({ accountId, balanceUSD, now });\n',
      );
    }
    return out;
  },
  [
    'hydrateDailyRiskState,',
    'persistDailyRiskState,',
    'await hydrateDailyRiskState({ accountId: riskAccountId, balanceUSD, now });',
    'await persistDailyRiskState({ accountId: riskAccountId, balanceUSD, now });',
    'checkDailyRiskLock({ accountId: riskAccountId, balanceUSD, now })',
    'reserveDailyLossBudget({ accountId: riskAccountId, balanceUSD,',
    'await persistDailyRiskState({ accountId, balanceUSD, now });',
  ],
);

patchFile(
  'server/oandaTrade.js',
  (source) => {
    let out = source;
    if (!out.includes('hydrateDailyRiskState,')) {
      out = out.replace(
        '  checkDailyRiskLock,\n',
        '  checkDailyRiskLock,\n  hydrateDailyRiskState,\n  persistDailyRiskState,\n',
      );
    }
    if (!out.includes('await hydrateDailyRiskState({ accountId: riskAccountId, balanceUSD });')) {
      out = out.replace(
        "  if (balanceUSD === 0 || isNaN(balanceUSD)) {\n    return blocked('Account balance is 0. Fund account before live trading.');\n  }\n\n  // ── Daily drawdown circuit breaker",
        "  if (balanceUSD === 0 || isNaN(balanceUSD)) {\n    return blocked('Account balance is 0. Fund account before live trading.');\n  }\n  const riskAccountId = client?.accountId || getAccountId();\n  await hydrateDailyRiskState({ accountId: riskAccountId, balanceUSD });\n  await persistDailyRiskState({ accountId: riskAccountId, balanceUSD });\n\n  // ── Daily drawdown circuit breaker",
      );
    }
    if (!out.includes('await persistDailyRiskState({ accountId: riskAccountId, balanceUSD });')) {
      out = out.replace(
        '  await hydrateDailyRiskState({ accountId: riskAccountId, balanceUSD });\n',
        '  await hydrateDailyRiskState({ accountId: riskAccountId, balanceUSD });\n  await persistDailyRiskState({ accountId: riskAccountId, balanceUSD });\n',
      );
    }
    out = out
      .replace('checkDailyRiskLock({ accountId: client?.accountId, balanceUSD })', 'checkDailyRiskLock({ accountId: riskAccountId, balanceUSD })')
      .replace('    accountId: client?.accountId,\n    balanceUSD,', '    accountId: riskAccountId,\n    balanceUSD,')
      .replace('  const accountId  = client?.accountId || getAccountId();', '  const accountId  = riskAccountId;');
    if (!out.includes('await persistDailyRiskState({ accountId, balanceUSD });')) {
      out = out.replace(
        '  markTradeOpened({ accountId, balanceUSD });\n',
        '  markTradeOpened({ accountId, balanceUSD });\n  await persistDailyRiskState({ accountId, balanceUSD });\n',
      );
    }
    return out;
  },
  [
    'hydrateDailyRiskState,',
    'persistDailyRiskState,',
    'await hydrateDailyRiskState({ accountId: riskAccountId, balanceUSD });',
    'await persistDailyRiskState({ accountId: riskAccountId, balanceUSD });',
    'checkDailyRiskLock({ accountId: riskAccountId, balanceUSD })',
    'accountId: riskAccountId,',
    'const accountId  = riskAccountId;',
    'await persistDailyRiskState({ accountId, balanceUSD });',
  ],
);

console.log('[DAILY_RISK_PERSISTENCE] durable daily lock and recovery sizing wired into ICT/PPR/V3 execution');
