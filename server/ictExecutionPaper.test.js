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

const NOW = new Date('2026-06-04T15:00:00Z');
const LIVE_CFG = { mode: 'live', autoTradeEnabled: true, minConfidence: 85, minRR: 2.0, maxRiskPercent: 1, signalTtlSec: 300 };
const freshId = (pair = 'EUR_USD') => `${pair}:${NOW.getTime() - 30_000}`;

const validParams = (over = {}) => ({
  pair: 'EUR_USD', direction: 'long', units: 0,
  entry: 1.1000, stopLoss: 1.0980, targetProfit: 1.1040, ictSignalId: freshId(),
  ...over,
});

// Confidence ≥ 85 so the central auto-execution floor passes; tests that need a
// rejection override it explicitly.
const goodAnalysis = (over = {}) => async () => ({ signal: 'buy', confidence: 92, rr: 2.5, signalId: freshId(), ...over });
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
  client: paperClient(), now: NOW, cfg: LIVE_CFG,
  getAnalysis: goodAnalysis(), getAccount: goodAccount,
  reconcile: async () => false, getOpen: async () => [], autoAi: true,
  ...over,
});

test('paper Auto AI trade executes WITHOUT FOREX_ALLOW_LIVE_EXECUTION', async () => {
  const client = paperClient();
  const r = await executeIctTrade(validParams(), baseDeps({ client }));
  assert.equal(r.success, true, r.reason);
  assert.equal(r.executionState, 'FILLED');
  assert.equal(client.calls.length, 1);
});

test('auto execution rejects confidence below the 85 threshold', async () => {
  const r = await executeIctTrade(validParams(), baseDeps({ getAnalysis: goodAnalysis({ confidence: 84 }) }));
  assert.equal(r.blocked, true);
  assert.match(r.reason, /84 < 85/);
});

test('insufficient margin blocks the paper trade with the exact message', async () => {
  const lowMarginAccount = async () => ({ balance: '10000', marginRate: '0.03', marginAvailable: '10' });
  const r = await executeIctTrade(validParams(), baseDeps({ getAccount: lowMarginAccount }));
  assert.equal(r.blocked, true);
  assert.equal(r.reason, 'Account margin restriction would be exceeded.');
});

test('total open Auto AI risk above 4.5% blocks a new trade', async () => {
  // Existing open trade: 250,000 EUR_USD, entry 1.10, stop 1.08 → $5,000 risk
  // on a $10,000 account = 50% open risk, well above the 4.5% cap.
  const heavyOpen = async () => [
    { instrument: 'EUR_USD', currentUnits: '250000', price: '1.10', stopLossOrder: { price: '1.08' } },
  ];
  const r = await executeIctTrade(validParams({ pair: 'GBP_USD', stopLoss: 1.0980, targetProfit: 1.1040 }), baseDeps({
    getAnalysis: goodAnalysis(), getOpen: heavyOpen,
  }));
  assert.equal(r.blocked, true);
  assert.match(r.reason, /exceed max 4\.5%/);
});
