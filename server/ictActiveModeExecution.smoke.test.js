import test from 'node:test';
import assert from 'node:assert/strict';
import { ictExecConfig, isIctExecutionEnabled } from './ictEngine.js';

test('ICT active mode with auto trade enabled is execution enabled', () => {
  const priorMode = process.env.ICT_ENGINE_MODE;
  const priorAuto = process.env.ICT_AUTO_TRADE_ENABLED;
  process.env.ICT_ENGINE_MODE = 'active';
  process.env.ICT_AUTO_TRADE_ENABLED = 'true';
  try {
    const cfg = ictExecConfig();
    assert.equal(cfg.autoTradeEnabled, true);
    assert.equal(isIctExecutionEnabled(), true);
  } finally {
    if (priorMode == null) delete process.env.ICT_ENGINE_MODE; else process.env.ICT_ENGINE_MODE = priorMode;
    if (priorAuto == null) delete process.env.ICT_AUTO_TRADE_ENABLED; else process.env.ICT_AUTO_TRADE_ENABLED = priorAuto;
  }
});
