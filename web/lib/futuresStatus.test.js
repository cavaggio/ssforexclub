import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapScannerTransportError, deriveFuturesView } from './futuresStatus.js';

// ─── transport error mapping (never raw "fetch failed") ─────────────────────
test('mapScannerTransportError maps Railway-unreachable to SCANNER_UNREACHABLE', () => {
  assert.equal(mapScannerTransportError({ status: 502, error: 'Scanner unreachable: fetch failed' }).code, 'SCANNER_UNREACHABLE');
  assert.equal(mapScannerTransportError({ status: 0, error: 'fetch failed' }).code, 'SCANNER_UNREACHABLE');
  assert.equal(mapScannerTransportError({ status: 0, error: 'ECONNREFUSED' }).code, 'SCANNER_UNREACHABLE');
});

test('mapScannerTransportError maps auth problems to INTERNAL_AUTH_FAILED', () => {
  assert.equal(mapScannerTransportError({ status: 401, error: 'Invalid or missing X-Internal-Auth header' }).code, 'INTERNAL_AUTH_FAILED');
  assert.equal(mapScannerTransportError({ status: 500, error: 'SCANNER_INTERNAL_SECRET not configured on the Next.js side' }).code, 'INTERNAL_AUTH_FAILED');
});

test('mapScannerTransportError falls back to SCANNER_ERROR', () => {
  assert.equal(mapScannerTransportError({ status: 500, error: 'something odd' }).code, 'SCANNER_ERROR');
});

// ─── deriveFuturesView: state machine ───────────────────────────────────────
const base = { enabled: true, liveFlag: false, liveAck: false, hasConnection: true, connectionEnvironment: 'paper', complianceMessage: null };

test('no credentials => NO_CREDENTIALS, paper mode, execute hidden', () => {
  const v = deriveFuturesView({ ...base, hasConnection: false, diagnostics: null });
  assert.equal(v.code, 'NO_CREDENTIALS');
  assert.equal(v.connection.label, 'No credentials saved');
  assert.equal(v.mode.label, 'Simulated / Paper mode');
  assert.equal(v.execution.label, 'Execution disabled');
  assert.equal(v.executeVisible, false);
});

test('connector disabled => execute hidden, disabled badge', () => {
  const v = deriveFuturesView({ ...base, enabled: false, diagnostics: null });
  assert.equal(v.code, 'CONNECTOR_DISABLED');
  assert.equal(v.executeVisible, false);
  assert.equal(v.execution.label, 'Execution disabled');
});

test('scanner unreachable => friendly message, execute hidden', () => {
  const v = deriveFuturesView({ ...base, diagnostics: { ok: false, code: 'SCANNER_UNREACHABLE' } });
  assert.equal(v.connection.label, 'Unable to reach scanner service');
  assert.equal(v.message, 'Unable to reach scanner service.');
  assert.equal(v.executeVisible, false);
  assert.equal(v.executeEnabled, false);
});

test('broker auth failed => Credential validation failed, execute hidden', () => {
  const v = deriveFuturesView({ ...base, diagnostics: { ok: false, code: 'BROKER_AUTH_FAILED', validationStatus: 'invalid' } });
  assert.equal(v.connection.label, 'Credential validation failed');
  assert.equal(v.execution.label, 'Execution disabled');
  assert.equal(v.executeVisible, false);
});

test('validated paper account never shows Live/Funded and is not executable even with liveFlag', () => {
  const v = deriveFuturesView({
    ...base, liveFlag: true, liveAck: true, connectionEnvironment: 'paper',
    diagnostics: { ok: true, code: 'OK', validationStatus: 'valid', selectedAccount: 'Sim101', accountMode: 'simulated', executionAllowed: false },
  });
  assert.equal(v.mode.label, 'Simulated / Paper mode');
  assert.equal(v.executeVisible, true);   // validated → button visible
  assert.equal(v.executeEnabled, false);  // ...but paper account can't execute live
  assert.equal(v.execution.label, 'Execution disabled');
});

test('no accounts => execute disabled even though validated', () => {
  const v = deriveFuturesView({
    ...base, liveFlag: true, liveAck: true, connectionEnvironment: 'live',
    diagnostics: { ok: true, code: 'NO_ACCOUNTS', validationStatus: 'valid', selectedAccount: null, accountMode: 'live', executionAllowed: true },
  });
  assert.equal(v.executeEnabled, false);
  assert.equal(v.mode.label, 'Simulated / Paper mode'); // no selected account => not live badge
});

test('live account with all gates passing => Execution enabled', () => {
  const v = deriveFuturesView({
    ...base, liveFlag: true, liveAck: true, connectionEnvironment: 'live',
    diagnostics: { ok: true, code: 'OK', validationStatus: 'valid', selectedAccount: 'APEX-1', accountMode: 'live', executionAllowed: true },
  });
  assert.equal(v.mode.label, 'Live / Funded mode');
  assert.equal(v.executeEnabled, true);
  assert.equal(v.execution.label, 'Execution enabled');
});

test('live account but live flag OFF => Execution disabled', () => {
  const v = deriveFuturesView({
    ...base, liveFlag: false, liveAck: true, connectionEnvironment: 'live',
    diagnostics: { ok: true, code: 'OK', validationStatus: 'valid', selectedAccount: 'APEX-1', accountMode: 'live', executionAllowed: false },
  });
  assert.equal(v.executeEnabled, false);
  assert.equal(v.execution.label, 'Execution disabled');
});

test('live account, flags on, but user has not acknowledged => Execution disabled', () => {
  const v = deriveFuturesView({
    ...base, liveFlag: true, liveAck: false, connectionEnvironment: 'live',
    diagnostics: { ok: true, code: 'OK', validationStatus: 'valid', selectedAccount: 'APEX-1', accountMode: 'live', executionAllowed: true },
  });
  assert.equal(v.executeEnabled, false);
});
