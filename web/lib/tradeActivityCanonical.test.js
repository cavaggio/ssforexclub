import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeTradeActivityRows } from './tradeActivityCanonical.js';

function row(overrides = {}) {
  return {
    id: overrides.id || Math.random().toString(36),
    created_at: overrides.created_at || '2026-08-19T14:00:00.000Z',
    event_type: overrides.event_type || 'opened',
    trade_id: overrides.trade_id === undefined ? '1341' : overrides.trade_id,
    broker_order_id: overrides.broker_order_id ?? null,
    instrument: overrides.instrument ?? 'USD_JPY',
    side: overrides.side ?? 'short',
    units_closed: overrides.units_closed ?? null,
    entry_price: overrides.entry_price ?? 158.3,
    exit_price: overrides.exit_price ?? null,
    realized_pl: overrides.realized_pl ?? null,
    reason: overrides.reason ?? null,
    raw_payload: overrides.raw_payload ?? null,
  };
}

test('phantom close rows without broker trade IDs are excluded', () => {
  const rows = [
    row({ id: 'open', event_type: 'opened', created_at: '2026-08-19T14:22:21.000Z' }),
    row({ id: 'phantom-1', event_type: 'closed', trade_id: null, created_at: '2026-08-19T14:52:30.000Z' }),
    row({ id: 'phantom-2', event_type: 'closed', trade_id: null, created_at: '2026-08-19T14:53:00.000Z' }),
  ];

  const result = canonicalizeTradeActivityRows(rows);
  assert.deepEqual(result.map((item) => item.id), ['open']);
});

test('one trade shows one open, unique partials, and one best terminal close', () => {
  const rows = [
    row({ id: 'open-a', event_type: 'opened', created_at: '2026-08-19T14:22:21.000Z' }),
    row({ id: 'open-duplicate', event_type: 'opened', created_at: '2026-08-19T14:22:22.000Z' }),
    row({ id: 'partial-a', event_type: 'partial_closed', broker_order_id: 'tx-1', units_closed: 1000, realized_pl: 82.75, created_at: '2026-08-19T14:57:40.000Z' }),
    row({ id: 'partial-duplicate', event_type: 'partial_closed', broker_order_id: 'tx-1', units_closed: 1000, realized_pl: 82.75, created_at: '2026-08-19T14:57:41.000Z' }),
    row({ id: 'weak-close', event_type: 'closed', created_at: '2026-08-19T14:57:42.000Z' }),
    row({
      id: 'broker-close',
      event_type: 'closed',
      broker_order_id: 'tx-2',
      exit_price: 158.302,
      realized_pl: -0.89,
      raw_payload: { source: 'oanda_transaction_sync' },
      created_at: '2026-08-19T14:57:49.000Z',
    }),
  ];

  const result = canonicalizeTradeActivityRows(rows);
  assert.equal(result.length, 3);
  assert.deepEqual(result.map((item) => item.id), ['broker-close', 'partial-duplicate', 'open-a']);
});

test('different broker trade IDs remain independent across pairs', () => {
  const rows = [
    row({ id: 'uj-open', trade_id: '1341', instrument: 'USD_JPY', event_type: 'opened' }),
    row({ id: 'uj-close', trade_id: '1341', instrument: 'USD_JPY', event_type: 'closed', realized_pl: 10, created_at: '2026-08-19T15:00:00.000Z' }),
    row({ id: 'eu-open', trade_id: '2002', instrument: 'EUR_USD', event_type: 'opened', created_at: '2026-08-19T15:01:00.000Z' }),
  ];

  const result = canonicalizeTradeActivityRows(rows);
  assert.deepEqual(result.map((item) => item.id), ['eu-open', 'uj-close', 'uj-open']);
});
