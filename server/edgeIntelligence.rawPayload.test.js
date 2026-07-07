import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTradeEdgeSnapshot, generateAttributionReport } from './edgeIntelligence.js';

test('Edge Intelligence reads nested Supabase trade_logs raw_payload close result', () => {
  const row = {
    instrument: 'GBP_JPY',
    direction: 'long',
    session: 'NY AM',
    created_at: '2026-07-07T13:00:00Z',
    raw_payload: {
      signal: {
        confidence: 88,
        score: 91,
        marketRegime: { regime: 'bullish_expansion', volatility: { state: 'expanded' } },
        macroAnalysis: { bias: 'bullish', risk: 'medium' },
      },
      closeResult: {
        status: 'closed',
        pnl: 42.75,
        closed_at: '2026-07-07T14:20:00Z',
      },
    },
  };

  const snap = buildTradeEdgeSnapshot(row);

  assert.equal(snap.pair, 'GBP_JPY');
  assert.equal(snap.pnl, 42.75);
  assert.equal(snap.winLoss, 'win');
  assert.equal(snap.exitTime, '2026-07-07T14:20:00.000Z');
  assert.equal(snap.marketRegime, 'bullish_expansion');
});

test('Edge report counts nested close payload as resolved', () => {
  const rows = [
    { instrument: 'EUR_USD', raw_payload: { closeResult: { pnl: 10 } } },
    { instrument: 'EUR_USD', raw_payload: { closeResult: { pnl: -5 } } },
    { instrument: 'GBP_JPY', raw_payload: { closeResult: { pnl: 25 } } },
  ];

  const report = generateAttributionReport(rows);

  assert.equal(report.overall.trades, 3);
  assert.equal(report.overall.resolved, 3);
  assert.equal(report.overall.wins, 2);
  assert.equal(report.overall.losses, 1);
});
