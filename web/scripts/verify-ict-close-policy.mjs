import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const routePath = resolve(process.cwd(), 'app/api/cron/active-trade-management/route.ts');
const policyPath = resolve(process.cwd(), 'lib/activeExitPolicy.js');
const route = readFileSync(routePath, 'utf8');
const policy = readFileSync(policyPath, 'utf8');

for (const marker of [
  'evaluateActiveExit',
  'closeUnitsForDecision',
  ".eq('auto_close_enabled', true)",
  'trade_exit_management_state',
  "decision.action === 'PARTIAL_CLOSE'",
  "'/api/internal/oanda/protection'",
  'automaticFullCloseDisabled: true',
  'outside_management_window_02:15-17:30_ET',
]) {
  if (!route.includes(marker)) {
    throw new Error(`Profit Protection v2 route verification failed: missing ${marker}`);
  }
}

for (const forbidden of [
  "units: 'ALL'",
  "action: 'FULL_CLOSE'",
  "decision.action === 'FULL_CLOSE'",
]) {
  if (route.includes(forbidden)) {
    throw new Error(`Profit Protection v2 route verification failed: forbidden ${forbidden}`);
  }
}

for (const marker of [
  "ACTIVE_EXIT_POLICY = 'profit_protection_v2'",
  "action: 'MOVE_STOP_TO_BREAKEVEN'",
  "action: 'PARTIAL_CLOSE'",
  "action: 'ARM_RUNNER'",
  "action: 'TRAIL_PROFIT'",
  'automaticFullCloseAllowed: false',
  "decision?.action !== 'PARTIAL_CLOSE'",
]) {
  if (!policy.includes(marker)) {
    throw new Error(`Profit Protection v2 policy verification failed: missing ${marker}`);
  }
}

for (const forbidden of ["action: 'FULL_CLOSE'", "return 'ALL'"]) {
  if (policy.includes(forbidden)) {
    throw new Error(`Profit Protection v2 policy verification failed: forbidden ${forbidden}`);
  }
}

console.log('Profit Protection v2 verified: no automatic full close; breakeven, one favorable-momentum partial, and post-TP trailing only.');
