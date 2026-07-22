import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  clearPairTradeCooldowns,
  isPairTradeCooldownActive,
  markPairTradeCooldown,
} from './oandaTrade.js';
import {
  deriveQualifiedManualRisk,
  targetRiskUsdFromBalance,
  validateQualifiedManualTargetRisk,
} from './manualExecutionRisk.js';

test('cooldown is scoped to a pair so distinct qualified pairs can execute in one scan', () => {
  clearPairTradeCooldowns();
  const now = Date.now();
  markPairTradeCooldown('EUR_GBP', now);
  assert.equal(isPairTradeCooldownActive('EUR_GBP', now + 1_000), true);
  assert.equal(isPairTradeCooldownActive('GBP_USD', now + 1_000), false);
  clearPairTradeCooldowns();
});

test('PPR dashboard scan route immediately attempts every qualified signal when Auto AI is enabled', () => {
  const indexSource = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  assert.match(indexSource, /const autoExecute = req\.body\?\.autoExecute === true/);
  assert.match(indexSource, /for \(const signal of qualified\)/);
  assert.match(indexSource, /executePprTrade\(signal/);
  assert.match(indexSource, /allQualifiedAttempted/);
});

test('authenticated dashboard forwards Auto AI execution intent and preserves results', () => {
  const routeSource = readFileSync(
    new URL('../web/app/api/scanner/scan/route.ts', import.meta.url),
    'utf8',
  );
  assert.match(routeSource, /autoAiTradingEnabled && selectedEngine === 'ppr'/);
  assert.match(routeSource, /autoExecute,/);
  assert.match(routeSource, /execution = rawScan\.execution/);
  assert.match(routeSource, /attempted=\$\{execution\?\.attempted/);
});

test('qualified manual risk is derived server-side as exactly 1.25% of active balance', async () => {
  assert.equal(targetRiskUsdFromBalance(100_000), 1_250);
  const risk = await deriveQualifiedManualRisk({
    client: { accountId: 'A' },
    getAccount: async () => ({ balance: '80000', currency: 'USD' }),
  });
  assert.deepEqual(risk, {
    balanceUSD: 80_000,
    targetRiskUSD: 1_000,
    riskPercent: 1.25,
    currency: 'USD',
    source: 'server_account_balance',
  });
  assert.equal(validateQualifiedManualTargetRisk({ targetRiskUSD: 1_000, balanceUSD: 80_000 }).allowed, true);
  assert.equal(validateQualifiedManualTargetRisk({ targetRiskUSD: 999, balanceUSD: 80_000 }).allowed, false);
});

test('Railway startup derives and propagates targetRiskUSD for ICT and PPR manual buttons', () => {
  const startup = readFileSync(new URL('../scripts/runtime_execution_start.mjs', import.meta.url), 'utf8');
  const patcher = readFileSync(new URL('../scripts/apply_manual_target_risk_runtime.mjs', import.meta.url), 'utf8');
  const router = readFileSync(new URL('./autoAiRouter.js', import.meta.url), 'utf8');
  const pprAuto = readFileSync(new URL('./pprAutoTrade.js', import.meta.url), 'utf8');
  const pprExecution = readFileSync(new URL('./pprExecution.js', import.meta.url), 'utf8');

  assert.match(startup, /applyManualTargetRiskRuntime\(\)/);
  assert.match(patcher, /deriveQualifiedManualRisk/);
  assert.match(patcher, /targetRiskUSD: manualRisk\.targetRiskUSD/);
  assert.match(patcher, /qualified_signal_button_ppr/);
  assert.match(patcher, /expectedTargetRiskUSD/);
  assert.match(patcher, /dynamicRisk\.riskPercent = 1\.25/);
  assert.match(router, /targetRiskUSD = null/);
  assert.match(router, /manualExecution = false/);
  assert.match(pprAuto, /executePprTrade\(executionCandidate/);
  assert.match(pprExecution, /targetRiskUSD: authoritativeTargetRiskUSD/);
});
