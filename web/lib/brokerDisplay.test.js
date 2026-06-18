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
  assert.equal(normalizeBroker('tradestation'), 'unknown');
  assert.equal(normalizeBroker(null), 'unknown');
  assert.equal(normalizeBroker(undefined), 'unknown');
});

test('brokerLabel never throws and labels unknown brokers safely', () => {
  assert.equal(brokerLabel('oanda'), 'OANDA');
  assert.equal(brokerLabel('ninjatrader'), 'NinjaTrader / Tradovate');
  assert.equal(brokerLabel('topstep'), 'Topstep');
  assert.equal(brokerLabel('mystery'), 'Unknown broker');
  assert.equal(brokerLabel(undefined), 'Unknown broker');
});

test('normalizeEnvironment maps sim→paper and passes through known values', () => {
  assert.equal(normalizeEnvironment('sim'), 'paper');
  assert.equal(normalizeEnvironment('paper'), 'paper');
  assert.equal(normalizeEnvironment('practice'), 'practice');
  assert.equal(normalizeEnvironment('live'), 'live');
  assert.equal(normalizeEnvironment(null), 'unknown');
});

test('normalizeValidationStatus handles canonical + legacy vocab, defaults to pending', () => {
  // canonical DB vocab
  assert.equal(normalizeValidationStatus('validated'), 'validated');
  assert.equal(normalizeValidationStatus('failed'), 'validation failed');
  assert.equal(normalizeValidationStatus('pending'), 'validation pending');
  // legacy values still understood
  assert.equal(normalizeValidationStatus('valid'), 'validated');
  assert.equal(normalizeValidationStatus('invalid'), 'validation failed');
  assert.equal(normalizeValidationStatus('unvalidated'), 'validation pending');
  // missing
  assert.equal(normalizeValidationStatus(null), 'validation pending');
  assert.equal(normalizeValidationStatus(undefined), 'validation pending');
});

// These mirror the settings-page rows — the page renders formatBrokerConnection()
// output, so if these never throw the page never crashes on these inputs.
test('formatBrokerConnection renders OANDA practice + live', () => {
  const p = formatBrokerConnection({ broker: 'oanda', environment: 'practice', accountId: '101-1', isActive: true, validationStatus: 'unvalidated' });
  assert.equal(p.brokerLabel, 'OANDA');
  assert.equal(p.environment, 'practice');
  const l = formatBrokerConnection({ broker: 'oanda', environment: 'live', accountId: '001-9', isActive: true, validationStatus: 'validated' });
  assert.equal(l.statusLabel, 'validated');
  assert.equal(l.statusTone, 'good');
});

test('formatBrokerConnection renders a NINJATRADER live row', () => {
  const r = formatBrokerConnection({ broker: 'ninjatrader', environment: 'live', accountId: 'cavaggio', isActive: true, validationStatus: 'failed' });
  assert.equal(r.brokerLabel, 'NinjaTrader / Tradovate');
  assert.equal(r.environment, 'live');
  assert.equal(r.statusLabel, 'validation failed');
  assert.equal(r.statusTone, 'bad');
});

test('formatBrokerConnection survives missing validation_status / account_mode / accountId', () => {
  const r = formatBrokerConnection({ broker: 'ninjatrader', environment: 'paper', isActive: true });
  assert.equal(r.statusLabel, 'saved · validation pending');
  assert.equal(r.accountLabel, '—');
});

test('formatBrokerConnection does not crash on an unknown broker or empty object', () => {
  assert.equal(formatBrokerConnection({ broker: 'weirdbroker', environment: 'x' }).brokerLabel, 'Unknown broker');
  assert.doesNotThrow(() => formatBrokerConnection({}));
  assert.doesNotThrow(() => formatBrokerConnection(null));
  assert.doesNotThrow(() => formatBrokerConnection(undefined));
});
