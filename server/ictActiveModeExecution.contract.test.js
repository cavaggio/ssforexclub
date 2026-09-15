import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('generated ICT runtime treats active mode as executable', () => {
  const engine = readFileSync(new URL('./ictEngine.js', import.meta.url), 'utf8');
  const execution = readFileSync(new URL('./ictExecution.js', import.meta.url), 'utf8');

  assert.match(engine, /ICT_MODE === 'active'/);
  assert.match(engine, /\(c\.mode === 'active' \|\| c\.mode === 'live'\) && c\.autoTradeEnabled === true/);
  assert.match(execution, /config\.mode === 'active' \|\| config\.mode === 'live'/);
  assert.doesNotMatch(execution, /config\.mode === 'live' && config\.autoTradeEnabled/);
});

test('FTMO qualification remains independent from MT5 execution readiness', () => {
  const autoAiRoute = readFileSync(
    new URL('../web/app/api/cron/auto-ai-trading/route.ts', import.meta.url),
    'utf8',
  );
  const executionRouter = readFileSync(
    new URL('./ftmoIctExecutionRouter.js', import.meta.url),
    'utf8',
  );

  assert.match(autoAiRoute, /requireExecutionReady:\s*false/);
  assert.match(autoAiRoute, /qualificationIndependentOfMt5Readiness=true/);
  assert.match(autoAiRoute, /oandaExecutionFallback=false/);

  // Qualification can continue without MT5, but actual FTMO order placement
  // must still fail closed on a stale/disconnected terminal.
  assert.match(executionRouter, /heartbeatFresh/);
  assert.match(executionRouter, /MT5 EA heartbeat is stale/);
  assert.match(executionRouter, /MT5 EA terminal is not connected/);
});
