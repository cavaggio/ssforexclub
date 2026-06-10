import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  autoAiExecutionEligibility,
  manualExecutionEligibility,
  isExecutableEnvironment,
} = await import('./autoAiGating.js');

test('paper Auto AI can run without the live-trading acknowledgement', () => {
  const r = autoAiExecutionEligibility({
    activeEnvironment: 'practice',
    brokerCredentialStatus: 'ready',
    platformLiveTradingEnabled: true,
    liveTradingAcknowledged: false,
  });
  assert.equal(r.allowed, true);
  assert.equal(r.mode, 'paper');
});

test('paper Auto AI can run without PLATFORM_LIVE_TRADING_ENABLED', () => {
  const r = autoAiExecutionEligibility({
    activeEnvironment: 'paper',
    brokerCredentialStatus: 'ready',
    platformLiveTradingEnabled: false,
    liveTradingAcknowledged: false,
  });
  assert.equal(r.allowed, true);
  assert.equal(r.mode, 'paper');
});

test('paper Auto AI still requires ready broker credentials', () => {
  const r = autoAiExecutionEligibility({
    activeEnvironment: 'practice',
    brokerCredentialStatus: 'no_credentials',
    platformLiveTradingEnabled: false,
    liveTradingAcknowledged: false,
  });
  assert.equal(r.allowed, false);
});

test('live Auto AI requires both the platform flag and the live acknowledgement', () => {
  // Missing platform flag.
  const noPlatform = autoAiExecutionEligibility({
    activeEnvironment: 'live',
    brokerCredentialStatus: 'ready',
    platformLiveTradingEnabled: false,
    liveTradingAcknowledged: true,
  });
  assert.equal(noPlatform.allowed, false);
  assert.equal(noPlatform.reason, 'platform_live_trading_disabled');

  // Missing live-ack.
  const noAck = autoAiExecutionEligibility({
    activeEnvironment: 'live',
    brokerCredentialStatus: 'ready',
    platformLiveTradingEnabled: true,
    liveTradingAcknowledged: false,
  });
  assert.equal(noAck.allowed, false);
  assert.equal(noAck.reason, 'live_not_acknowledged');

  // Both present → allowed.
  const ok = autoAiExecutionEligibility({
    activeEnvironment: 'live',
    brokerCredentialStatus: 'ready',
    platformLiveTradingEnabled: true,
    liveTradingAcknowledged: true,
  });
  assert.equal(ok.allowed, true);
  assert.equal(ok.mode, 'live');
});

test('paper manual execute button appears for a qualified paper signal', () => {
  const r = manualExecutionEligibility({
    activeEnvironment: 'practice',
    brokerCredentialStatus: 'ready',
    platformLiveTradingEnabled: false,
    liveTradingAcknowledged: false,
  });
  assert.equal(r.allowed, true);
  assert.equal(r.label, 'Execute Paper Trade');
});

test('live manual execution still requires platform flag and live-ack', () => {
  const blocked = manualExecutionEligibility({
    activeEnvironment: 'live',
    brokerCredentialStatus: 'ready',
    platformLiveTradingEnabled: false,
    liveTradingAcknowledged: true,
  });
  assert.equal(blocked.allowed, false);

  const ok = manualExecutionEligibility({
    activeEnvironment: 'live',
    brokerCredentialStatus: 'ready',
    platformLiveTradingEnabled: true,
    liveTradingAcknowledged: true,
  });
  assert.equal(ok.allowed, true);
  assert.equal(ok.label, 'Execute Live Trade');
});

test('executable environments are live, practice, and paper', () => {
  assert.equal(isExecutableEnvironment('live'), true);
  assert.equal(isExecutableEnvironment('practice'), true);
  assert.equal(isExecutableEnvironment('paper'), true);
  assert.equal(isExecutableEnvironment('demo'), false);
  assert.equal(isExecutableEnvironment(''), false);
});
