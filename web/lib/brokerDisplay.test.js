import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeBroker,
  brokerLabel,
  normalizeEnvironment,
  normalizeValidationStatus,
  formatBrokerConnection,
} from './brokerDisplay.js';

test('normalizeBroker recognizes known brokers and maps the rest to unknown', () => {
  assert.equal(normalizeBroker('oanda'), 'oanda');
  assert.equal(normalizeBroker('NINJATRADER'), 'ninjatrader');
  assert.equal(normalizeBroker('topstep'), 'topstep');
  assert.equal(normalizeBroker('ftmo'), 'ftmo');
  assert.equal(normalizeBroker('tradestation'), 'unknown');
  assert.equal(normalizeBroker(null), 'unknown');
});

test('brokerLabel labels FTMO as MetaTrader 5 bridge', () => {
  assert.equal(brokerLabel('oanda'), 'OANDA');
  assert.equal(brokerLabel('ninjatrader'), 'NinjaTrader / Tradovate');
  assert.equal(brokerLabel('topstep'), 'Topstep');
  assert.equal(brokerLabel('ftmo'), 'FTMO / MetaTrader 5 Bridge');
  assert.equal(brokerLabel('mystery'), 'Unknown broker');
});

test('normalizeEnvironment supports FTMO lifecycle environments', () => {
  assert.equal(normalizeEnvironment('sim'), 'paper');
  assert.equal(normalizeEnvironment('challenge'), 'challenge');
  assert.equal(normalizeEnvironment('verification'), 'verification');
  assert.equal(normalizeEnvironment('funded'), 'funded');
  assert.equal(normalizeEnvironment(null), 'unknown');
});

test('normalizeValidationStatus handles canonical + legacy vocab', () => {
  assert.equal(normalizeValidationStatus('validated'), 'validated');
  assert.equal(normalizeValidationStatus('failed'), 'validation failed');
  assert.equal(normalizeValidationStatus('pending'), 'validation pending');
  assert.equal(normalizeValidationStatus('valid'), 'validated');
  assert.equal(normalizeValidationStatus('invalid'), 'validation failed');
  assert.equal(normalizeValidationStatus(null), 'validation pending');
});

test('formatBrokerConnection renders OANDA and NinjaTrader rows', () => {
  const p = formatBrokerConnection({ broker: 'oanda', environment: 'practice', accountId: '101-1', isActive: true, validationStatus: 'unvalidated' });
  assert.equal(p.brokerLabel, 'OANDA');
  const n = formatBrokerConnection({ broker: 'ninjatrader', environment: 'live', accountId: 'cavaggio', isActive: true, validationStatus: 'failed' });
  assert.equal(n.statusTone, 'bad');
});

test('formatBrokerConnection renders FTMO MT5 challenge row', () => {
  const row = formatBrokerConnection({ broker: 'ftmo', environment: 'challenge', accountId: '12345678', isActive: true, validationStatus: 'validated' });
  assert.equal(row.brokerLabel, 'FTMO / MetaTrader 5 Bridge');
  assert.equal(row.environment, 'challenge');
  assert.equal(row.accountLabel, '12345678');
  assert.equal(row.statusTone, 'good');
});

test('formatBrokerConnection survives missing or unknown fields', () => {
  const r = formatBrokerConnection({ broker: 'ninjatrader', environment: 'paper', isActive: true });
  assert.equal(r.statusLabel, 'saved · validation pending');
  assert.equal(r.accountLabel, '—');
  assert.equal(formatBrokerConnection({ broker: 'weirdbroker', environment: 'x' }).brokerLabel, 'Unknown broker');
  assert.doesNotThrow(() => formatBrokerConnection(undefined));
});
