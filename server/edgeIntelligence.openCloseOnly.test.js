import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTradeEdgeSnapshot, generateAttributionReport } from './edgeIntelligence.js';

test('Edge ignores REASSESSED snapshots even if they include temporary P/L', () => {
  const snap = buildTradeEdgeSnapshot({
    status: 'REASSESSED',
    instrument: 'GBP_JPY',
    pnl: 6.63,
    created_at: '2026-07-07T12:00:00Z',
  });

  assert.equal(snap, null);
});

test('Edge counts only CLOSED outcomes as resolved', () => {
  const report = generateAttributionReport([
    {
      status: 'OPENED',
      instrument: 'GBP_JPY',
      direction: 'long',
      created_at: '2026-07-07T10:00:00Z',
    },
    {
      status: 'REASSESSED',
      instrument: 'GBP_JPY',
      pnl: 6.63,
      created_at: '2026-07-07T10:15:00Z',
    },
    {
      status: 'CLOSED',
      instrument: 'GBP_JPY',
      pnl: 12.50,
      closed_at: '2026-07-07T11:00:00Z',
    },
  ]);

  assert.equal(report.overall.trades, 2);      // OPENED + CLOSED are trade records
  assert.equal(report.overall.resolved, 1);    // only CLOSED has final P/L
  assert.equal(report.overall.wins, 1);
  assert.equal(report.overall.losses, 0);
});
