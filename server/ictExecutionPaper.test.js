import { test } from 'node:test';
import assert from 'node:assert/strict';

// Crucially: do NOT set FOREX_ALLOW_LIVE_EXECUTION here — paper must execute
// without the live-trading acknowledgement. Pin the risk caps to defaults.
delete process.env.FOREX_ALLOW_LIVE_EXECUTION;
delete process.env.RISK_MAX_PER_TRADE_PERCENT;
delete process.env.RISK_DAILY_MAX_DRAWDOWN_PERCENT;
delete process.env.RISK_AUTO_EXECUTION_MIN_CONFIDENCE;
delete process.env.AUTO_AI_MAX_TOTAL_OPEN_RISK_PERCENT;
delete process.env.RISK_CONSERVATIVE_TRIGGER_PERCENT;
delete process.env.RISK_CONSERVATIVE_MIN_CONFIDENCE;

const { executeIctTrade } = await import('./ictExecution.js');
const { reassessIctTrade } = await import('./ictLifecycleEngine.js');
const { resetDailyRisk } = await import('./riskManager.js');

const NOW = new Date('2026-06-04T15:00:00Z');
const LIVE_CFG = { mode: 'live', autoTradeEnabled: true, minConfidence: 80, minRR: 2.0, maxRiskPercent: 1, signalTtlSec: 300 };
const freshId = (pair = 'EUR_USD') => `${pair}:${NOW.getTime() - 30_000}`;

const validParams = (over = {}) => ({
  pair: 'EUR_USD', direction: 'long', units: 0,
  entry: 1.1000, stopLoss: 1.0980, targetProfit: 1.1040, ictSignalId: freshId(),
  ...over,
});

// Confidence ≥ 90 so the central auto-execution floor passes; tests that need a
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

test('auto execution rejects confidence below the 90 floor', async () => {
  const r = await executeIctTrade(validParams(), baseDeps({ getAnalysis: goodAnalysis({ confidence: 85 }) }));
  assert.equal(r.blocked, true);
  assert.match(r.reason, /floor 90%/);
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

test('ICT (auto) cannot exceed 1.4% risk even when the engine asks for 5%', async () => {
  resetDailyRisk();
  const client = paperClient();
  // Engine wants 5% per trade; the central cap clamps the sized risk to ≤1.4%.
  const r = await executeIctTrade(validParams(), baseDeps({ client, cfg: { ...LIVE_CFG, maxRiskPercent: 5 } }));
  assert.equal(r.success, true, r.reason);
  assert.ok(r.riskUSD <= 140 + 0.01, `risk $${r.riskUSD} must be ≤ 1.4% ($140) of $10k`);
});

test('ICT (manual) entries are also capped at 1.4% risk', async () => {
  resetDailyRisk();
  const client = paperClient();
  // autoAi:false → manual path; the per-trade cap still applies (≤1.4%).
  const r = await executeIctTrade(validParams(), baseDeps({ client, autoAi: false, cfg: { ...LIVE_CFG, maxRiskPercent: 5 } }));
  assert.equal(r.success, true, r.reason);
  assert.ok(r.riskUSD <= 140 + 0.01, `risk $${r.riskUSD} must be ≤ 1.4% ($140) of $10k`);
});

test('daily lock blocks NEW entries but open-trade management still works', async () => {
  resetDailyRisk();
  const client = paperClient();
  // Seed the day's baseline at $10k, then present a balance down 3% (> 2.8%).
  await executeIctTrade(validParams(), baseDeps({ client, getAccount: async () => ({ balance: '10000', marginRate: '0.03', marginAvailable: '9000' }) }));
  const locked = await executeIctTrade(validParams(), baseDeps({
    client, getAccount: async () => ({ balance: '9700', marginRate: '0.03', marginAvailable: '9000' }),
  }));
  assert.equal(locked.blocked, true);
  assert.match(locked.reason, /Daily drawdown limit reached/);

  // Management path (reassessment) is NOT gated by the daily lock — it still
  // produces an action for an open, past-hold trade.
  const mgmt = reassessIctTrade({
    pair: 'EUR_USD', direction: 'long', entryPrice: 1.1, currentPrice: 1.0985, target1: 1.104,
    candles: [], now: NOW, openedAtMs: NOW.getTime() - 5 * 60 * 60 * 1000, holdMinutes: 120, lastReassessMs: null,
  });
  assert.equal(mgmt.reassessDue, true);
  assert.ok(typeof mgmt.action === 'string' && mgmt.action.length > 0);
});
