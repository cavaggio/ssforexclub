import test from 'node:test';
import assert from 'node:assert/strict';
import { pprConfig, pprExecutionReadiness, pprScanCounts } from './pprEngine.js';
import { pprExecutionConfidenceFloor } from './oandaTrade.js';

function withEnv(values, fn) {
  const prior = {};
  for (const [key, value] of Object.entries(values)) {
    prior[key] = process.env[key];
    if (value == null) delete process.env[key];
    else process.env[key] = String(value);
  }
  try { return fn(); } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('PPR confidence cannot be configured below 80%', () => {
  withEnv({ PPR_MIN_CONFIDENCE: '72' }, () => {
    assert.equal(pprConfig().minConfidence, 80);
    assert.equal(pprExecutionConfidenceFloor(), 80);
  });
  withEnv({ PPR_MIN_CONFIDENCE: '91' }, () => {
    assert.equal(pprConfig().minConfidence, 91);
    assert.equal(pprExecutionConfidenceFloor(), 91);
  });
});

test('PPR scan accounting separates qualified, watching, and rejected pairs', () => {
  assert.deepEqual(
    pprScanCounts({ qualified: [{}, {}], watchCandidates: [{}], rejected: [{}, {}] }),
    { qualifiedCount: 2, watchCount: 1, rejectedCount: 2, accountedFor: 5 },
  );
});

test('PPR live readiness reports the exact environment blockers', () => {
  withEnv({ FOREX_AUTO_TRADE_ENABLED: 'true', FOREX_ALLOW_LIVE_EXECUTION: 'true' }, () => {
    const ready = pprExecutionReadiness({ client: { environment: 'live' }, config: { minConfidence: 80, minRR: 1.5 } });
    assert.equal(ready.liveReady, true);
    assert.deepEqual(ready.blockers, []);
  });
  withEnv({ FOREX_AUTO_TRADE_ENABLED: 'true', FOREX_ALLOW_LIVE_EXECUTION: 'true' }, () => {
    const practice = pprExecutionReadiness({ client: { environment: 'practice' }, config: { minConfidence: 80, minRR: 1.5 } });
    assert.equal(practice.liveReady, false);
    assert.match(practice.blockers.join(' '), /practice, not live/);
  });
  withEnv({ FOREX_AUTO_TRADE_ENABLED: 'false', FOREX_ALLOW_LIVE_EXECUTION: 'false' }, () => {
    const blocked = pprExecutionReadiness({ client: { environment: 'live' }, config: { minConfidence: 80, minRR: 1.5 } });
    assert.equal(blocked.liveReady, false);
    assert.equal(blocked.blockers.length, 2);
  });
});
