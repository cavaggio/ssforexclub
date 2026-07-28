import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  buildIctWatchState,
  maskAccountForLog,
} from './ictAutoTrade.js';
import { buildOandaSyncDiagnosticLines } from './ictAutoScheduler.js';

const validGeometry = {
  entry: 163.90,
  stopLoss: 163.70,
  target1: 164.20,
  rr: 1.5,
  targetAdjustedToMinRR: false,
};

test('account log labels distinguish same-suffix OANDA accounts without exposing full IDs', () => {
  const first = '101-001-39311050-001';
  const second = '101-001-39320094-001';
  const firstLabel = maskAccountForLog(first);
  const secondLabel = maskAccountForLog(second);

  assert.equal(firstLabel, '101…1050…001');
  assert.equal(secondLabel, '101…0094…001');
  assert.notEqual(firstLabel, secondLabel);
  assert.equal(firstLabel.includes(first), false);
  assert.equal(secondLabel.includes(second), false);
});

test('near-qualified watch state uses explicit signal state instead of serialized ICT keywords', () => {
  const state = buildIctWatchState([
    {
      pair: 'GBP_JPY',
      signal: 'none',
      confidence: 99,
      rr: 2,
      ictBias: 'neutral',
      concepts: { liquiditySweep: false, fvgs: [], orderBlock: {} },
      conceptsDetected: [],
      rejectionReasons: ['Hard gate: Daily and 4H directional bias are not aligned.'],
      ...validGeometry,
    },
    {
      pair: 'USD_JPY',
      signal: 'none',
      confidence: 84,
      ictBias: 'bullish',
      freshImpulse: false,
      conceptsDetected: ['Daily+4H aligned (bullish)', 'Killzone: New York', 'Liquidity sweep (Equal Highs)'],
      rejectionReasons: [
        'Hard gate: no 5M entry-timing trigger.',
        'Hard gate: no fresh 5M impulse/structure trigger for a market scalp entry.',
      ],
      ...validGeometry,
    },
    {
      pair: 'EUR_USD',
      signal: 'none',
      confidence: 96,
      ictBias: 'bullish',
      freshImpulse: true,
      conceptsDetected: ['Displacement bullish', 'Daily+4H aligned (bullish)'],
      rejectionReasons: ['Hard gate: late market entry — price drifted 0.80 ATR from the ideal ICT entry.'],
      entry: 1.10,
      stopLoss: 1.09,
      target1: 1.115,
      rr: 1.5,
      targetAdjustedToMinRR: false,
    },
    {
      pair: 'EUR_GBP',
      signal: 'buy',
      confidence: 95,
      ictBias: 'bullish',
      freshImpulse: true,
      conceptsDetected: ['Displacement bullish'],
      rejectionReasons: [],
      entry: 0.85,
      stopLoss: 0.845,
      target1: 0.8575,
      rr: 1.5,
      targetAdjustedToMinRR: false,
    },
  ], 93, 1.5);

  assert.deepEqual(state.nearQualifiedPairs, ['USD_JPY']);
  assert.deepEqual(state.hotPairs, ['EUR_GBP']);
  assert.deepEqual(state.lateEntryPairs, ['EUR_USD']);
  assert.equal(state.nearQualifiedPairs.includes('GBP_JPY'), false);
});

test('Railway transaction diagnostics emit account and close attribution without full account IDs', () => {
  const fullAccountId = '101-001-39311050-001';
  const payload = JSON.stringify({
    results: [{
      user: 'user…q4',
      sync: {
        accountId: fullAccountId,
        accountLabel: '101…1050…001',
        environment: 'practice',
        fetched: 2,
        closeEvents: 1,
        logged: 1,
        failed: 0,
        reservationsReleased: 0,
        reservationsLossLocked: 1,
        closeDetails: [{
          tradeId: '273',
          instrument: 'USD_JPY',
          side: 'long',
          closeReason: 'SL_HIT',
          realizedPL: -256.36,
          price: 163.885,
          unitsClosed: 800000,
          reservationState: 'loss_locked',
          logged: true,
        }],
      },
    }],
  });

  const lines = buildOandaSyncDiagnosticLines(payload);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /\[ACCOUNT\].*account=101…1050…001.*closeEvents=1/);
  assert.match(lines[1], /\[CLOSE\].*tradeId=273.*pair=USD_JPY.*pnl=-256\.36.*loss_locked/);
  assert.equal(lines.join('\n').includes(fullAccountId), false);
});

test('build source preserves one ICT confidence model from signal through Open Trade', () => {
  const root = resolve(import.meta.dirname, '..');
  const indexSource = readFileSync(resolve(root, 'server/index.js'), 'utf8');
  const engineSource = readFileSync(resolve(root, 'server/ictEngine.js'), 'utf8');
  const monitorSource = readFileSync(resolve(root, 'server/oandaActiveTradeMonitor.js'), 'utf8');
  const syncSource = readFileSync(resolve(root, 'web/lib/oandaTransactionSync.ts'), 'utf8');

  assert.match(indexSource, /const ictExecutionEnabled = isIctExecutionEnabled\(\);/);
  assert.match(engineSource, /targetHitConfidence: confidence/);
  assert.match(monitorSource, /confidenceModel: pureIctTrade \? 'ict_target_hit_lifecycle'/);
  assert.match(monitorSource, /ictProbabilitiesFromConfidence\(currentConfidence\)/);
  assert.match(syncSource, /closeDetails: CloseDiagnostic\[\]/);
  assert.match(syncSource, /console\.log\(`\$\{tag\} close=\$\{JSON\.stringify\(diagnostic\)\}`\);/);
});
