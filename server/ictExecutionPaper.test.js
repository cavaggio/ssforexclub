import { test } from 'node:test';
import assert from 'node:assert/strict';

// Crucially: do NOT set FOREX_ALLOW_LIVE_EXECUTION here — paper must execute
// without the live-trading acknowledgement. Pin the risk caps to defaults.
delete process.env.FOREX_ALLOW_LIVE_EXECUTION;
delete process.env.RISK_MAX_PER_TRADE_PERCENT;
delete process.env.RISK_DAILY_MAX_DRAWDOWN_PERCENT;
delete process.env.RISK_AUTO_EXECUTION_MIN_CONFIDENCE;
delete process.env.AUTO_AI_MAX_TOTAL_OPEN_RISK_PERCENT;

const { executeIctTrade } = await import('./ictExecution.js');
const { __resetExecutionReservationsForTests } = await import('./executionReservations.js');

const NOW = new Date('2026-06-04T15:00:00Z');
const ACTIVE_CFG = { mode: 'active', autoTradeEnabled: true, minConfidence: 75, minRR: 1.5, maxRiskPercent: 1, signalTtlSec: 300 };
const freshId = (pair = 'EUR_USD') => `${pair}:${NOW.getTime() - 30_000}`;

const validParams = (over = {}) => ({
  pair: 'EUR_USD', direction: 'long', units: 0,
  entry: 1.1000, stopLoss: 1.0980, targetProfit: 1.1040, ictSignalId: freshId(),
  ...over,
});

const goodAnalysis = (over = {}) => async () => ({
  signal: 'buy', confidence: 95, targetHitConfidence: 95, confluenceScore: 95,
  rr: 2.5, signalId: freshId(),
  entry: 1.1000, idealEntry: 1.1000, entryZoneLow: 1.0998, entryZoneHigh: 1.1002,
  entrySource: 'FVG', stopLoss: 1.0980, target1: 1.1040,
  entryTimeframe: '5M', entryCandle: { triggerReady: true },
  atrPips: 10, freshImpulse: true, triggerAgeBars: 0,
  entryAuthorization: {
    ready: true,
    mode: 'initial_reversal_mss',
    cycleId: '2026-06-04:EUR_USD:bullish:h4_fvg:initial',
  },
  marketMakerModel: { studyReady: true, stage: 'DISTRIBUTION_ACTIVE' },
  h1Transition: {
    ready: true,
    transitionId: 'bullish:2026-06-04T15:00:00.000Z',
    reason: 'Test H1 countertrend-to-bias transition is ready.',
  },
  minimumRR: 1.5, targetAdjustedToMinRR: false,
  setupType: 'ICT 2022 Model', conceptsDetected: [], concepts: {},
  ...over,
});
const goodAccount = async () => ({ balance: '10000', marginRate: '0.03', marginAvailable: '9000' });

function paperClient() {
  const calls = [];
  return {
    accountId: 'ACC-PAPER',
    environment: 'practice',
    calls,
    post: async (path, body) => {
      calls.push({ path, body });
      return { orderFillTransaction: { id: 'tx1', price: '1.1001', tradeOpened: { tradeID: 'TPAPER' } } };
    },
  };
}

const baseDeps = (over = {}) => ({
  client: paperClient(), now: NOW, cfg: ACTIVE_CFG,
  getAnalysis: goodAnalysis(), getAccount: goodAccount,
  reconcile: async () => false, getOpen: async () => [], autoAi: true,
  ...over,
});

test('ICT active mode executes a practice trade without FOREX_ALLOW_LIVE_EXECUTION', async () => {
  __resetExecutionReservationsForTests();
  const client = paperClient();
  const r = await executeIctTrade(validParams(), baseDeps({ client }));
  assert.equal(r.success, true, r.reason);
  assert.equal(r.executionState, 'FILLED');
  assert.equal(client.calls.length, 1);
});

test('closing a trade cannot reopen the same market-maker entry cycle', async () => {
  __resetExecutionReservationsForTests();
  const client = paperClient();
  client.accountId = 'ACC-PAPER-H1-GUARD';
  const deps = baseDeps({ client });

  const first = await executeIctTrade(validParams(), deps);
  assert.equal(first.success, true, first.reason);

  // Broker reconciliation can report no open duplicate after a close, but the
  // independent market-maker-cycle reservation must still reject the stale re-entry.
  const reopened = await executeIctTrade(validParams(), deps);
  assert.equal(reopened.blocked, true);
  assert.match(reopened.reason, /ICT entry-cycle guard rejected/i);
  assert.equal(client.calls.length, 1);
});

test('ICT shadow mode remains blocked', async () => {
  const r = await executeIctTrade(validParams(), baseDeps({
    cfg: { ...ACTIVE_CFG, mode: 'shadow' },
  }));
  assert.equal(r.blocked, true);
  assert.match(r.reason, /ICT execution disabled/);
});

test('auto execution rejects confidence below the authoritative threshold', async () => {
  const r = await executeIctTrade(validParams(), baseDeps({ getAnalysis: goodAnalysis({ confidence: 74 }) }));
  assert.equal(r.blocked, true);
  assert.match(r.reason, /74 < 75/);
});

test('insufficient margin blocks the paper trade with the exact message', async () => {
  const lowMarginAccount = async () => ({ balance: '10000', marginRate: '0.03', marginAvailable: '10' });
  const r = await executeIctTrade(validParams(), baseDeps({ getAccount: lowMarginAccount }));
  assert.equal(r.blocked, true);
  assert.equal(r.reason, 'Account margin restriction would be exceeded.');
});

test('open stop risk exhausts the stricter daily-loss budget before the portfolio cap', async () => {
  const heavyOpen = async () => [
    { instrument: 'EUR_USD', currentUnits: '250000', price: '1.10', stopLossOrder: { price: '1.08' } },
  ];
  const r = await executeIctTrade(validParams({ pair: 'GBP_USD', stopLoss: 1.0980, targetProfit: 1.1040 }), baseDeps({
    getAnalysis: goodAnalysis(), getOpen: heavyOpen,
  }));
  assert.equal(r.blocked, true);
  assert.match(r.reason, /No uncommitted daily loss budget remains/);
});
