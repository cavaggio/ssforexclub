import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mapScannerTransportError,
  deriveFuturesView,
  pickConnectionForEnvironment,
  environmentMismatchMessage,
  classifyValidationResult,
} from './futuresStatus.js';

// ─── validation classification (drives persisted validation_status) ─────────
test('OANDA 200 probe (no diagnostic code) => validated', () => {
  assert.equal(classifyValidationResult({ ok: true }), 'validated');
});

test('futures diagnostics OK / NO_ACCOUNTS => validated', () => {
  assert.equal(classifyValidationResult({ ok: true, code: 'OK', validationStatus: 'valid' }), 'validated');
  assert.equal(classifyValidationResult({ ok: true, code: 'NO_ACCOUNTS', validationStatus: 'valid' }), 'validated');
});

test('broker auth failure => failed', () => {
  assert.equal(classifyValidationResult({ ok: true, code: 'BROKER_AUTH_FAILED', validationStatus: 'invalid' }), 'failed');
  assert.equal(classifyValidationResult({ ok: false, transportCode: 'SCANNER_ERROR' }), 'failed');
});

test('unreachable / internal-auth / connector-disabled => skip (never mark a good account failed)', () => {
  assert.equal(classifyValidationResult({ ok: false, transportCode: 'SCANNER_UNREACHABLE' }), 'skip');
  assert.equal(classifyValidationResult({ ok: false, transportCode: 'INTERNAL_AUTH_FAILED' }), 'skip');
  assert.equal(classifyValidationResult({ ok: true, code: 'CONNECTOR_DISABLED' }), 'skip');
});

// ─── environment selection / mismatch ───────────────────────────────────────
const liveConn = { id: '1', environment: 'live' };
const paperConn = { id: '2', environment: 'paper' };

test('live connection exists but paper requested => no match (mismatch)', () => {
  const r = pickConnectionForEnvironment([liveConn], 'paper');
  assert.equal(r.match, null);
  assert.deepEqual(r.savedEnvironments, ['live']);
});

test('paper connection exists but live requested => no match (mismatch)', () => {
  const r = pickConnectionForEnvironment([paperConn], 'live');
  assert.equal(r.match, null);
});

test('matching environment selects the connection', () => {
  assert.equal(pickConnectionForEnvironment([liveConn, paperConn], 'live').match.id, '1');
  assert.equal(pickConnectionForEnvironment([liveConn, paperConn], 'paper').match.id, '2');
});

test('missing matching environment returns null so broker auth is never attempted', () => {
  assert.equal(pickConnectionForEnvironment([], 'paper').match, null);
});

test('mismatch message is specific, never generic auth failure', () => {
  const m = environmentMismatchMessage('live', 'paper');
  assert.match(m, /Live/);
  assert.match(m, /Simulated \/ Paper/);
  assert.doesNotMatch(m, /authentication failed/i);
});

test('ENVIRONMENT_MISMATCH code renders the specific message, execute hidden', () => {
  const v = deriveFuturesView({
    enabled: true, liveFlag: false, liveAck: false, hasConnection: true, connectionEnvironment: 'live',
    diagnostics: { ok: false, code: 'ENVIRONMENT_MISMATCH', message: environmentMismatchMessage('live', 'paper') },
  });
  assert.equal(v.connection.label, 'Environment mismatch');
  assert.match(v.message, /Switch to Live/);
  assert.equal(v.executeVisible, false);
  assert.equal(v.execution.label, 'Execution disabled');
});

test('saved live connection shows Live/Funded mode even before validation', () => {
  const v = deriveFuturesView({
    enabled: true, liveFlag: false, liveAck: false, hasConnection: true, connectionEnvironment: 'live',
    diagnostics: { ok: false, code: 'BROKER_AUTH_FAILED', validationStatus: 'invalid' },
  });
  assert.equal(v.mode.label, 'Live / Funded mode'); // reflects saved choice, not validation
  assert.equal(v.connection.label, 'Credential validation failed');
  assert.equal(v.executeVisible, false);
});


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
  assert.equal(v.executeEnabled, false); // no selected account => not executable
  assert.equal(v.mode.label, 'Live / Funded mode'); // mode reflects the saved live connection
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
