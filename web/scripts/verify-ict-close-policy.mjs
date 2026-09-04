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
    throw new Error(`Profit Protection v3 route verification failed: missing ${marker}`);
  }
}

for (const forbidden of [
  "units: 'ALL'",
  "action: 'FULL_CLOSE'",
  "decision.action === 'FULL_CLOSE'",
]) {
  if (route.includes(forbidden)) {
    throw new Error(`Profit Protection v3 route verification failed: forbidden ${forbidden}`);
  }
}

for (const marker of [
  "ACTIVE_EXIT_POLICY = 'profit_protection_v3'",
  'FIXED_STOP_LOSS_PIPS = 10',
  'FIRST_TAKE_PROFIT_PIPS = 15',
  'FIRST_PARTIAL_PERCENT = 80',
  'FINAL_TAKE_PROFIT_PIPS = 18',
  'FINAL_PARTIAL_PERCENT = 20',
  'FIXED_RR = 1.5',
  "action: 'MOVE_STOP_TO_BREAKEVEN'",
  "action: 'PARTIAL_CLOSE'",
  'automaticFullCloseAllowed: false',
  "decision?.action !== 'PARTIAL_CLOSE'",
]) {
  if (!policy.includes(marker)) {
    throw new Error(`Profit Protection v3 policy verification failed: missing ${marker}`);
  }
}

for (const forbidden of ["action: 'FULL_CLOSE'", "return 'ALL'"]) {
  if (policy.includes(forbidden)) {
    throw new Error(`Profit Protection v3 policy verification failed: forbidden ${forbidden}`);
  }
}

console.log('Profit Protection v3 verified: fixed 10 pip SL, 80% partial at +15 pips, breakeven remaining 20%, and final 20% close at +18 pips; no automatic full close.');
