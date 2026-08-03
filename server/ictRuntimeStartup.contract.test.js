import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { selectExecutableQuote } from './oandaExecutableQuote.js';

const runtimeSource = readFileSync(
  new URL('../scripts/runtime_execution_start.mjs', import.meta.url),
  'utf8',
);
const engineSource = readFileSync(new URL('./ictEngine.js', import.meta.url), 'utf8');
const executionSource = readFileSync(new URL('./ictExecution.js', import.meta.url), 'utf8');
const serverIndexSource = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
const qualifiedRouteSource = readFileSync(
  new URL('../web/app/api/scanner/execute-qualified/route.ts', import.meta.url),
  'utf8',
);

test('Railway startup recognizes the evolved ICT R:R contract before invoking the legacy patcher', () => {
  const guardIndex = runtimeSource.indexOf('if (hasIctRrRuntimeContract(before))');
  const patchCallIndex = runtimeSource.indexOf('applyIctRrFloorRuntime();');

  assert.ok(guardIndex >= 0, 'stable ICT R:R contract guard is missing');
  assert.ok(patchCallIndex > guardIndex, 'legacy patcher must run only after the stable contract guard');
  assert.match(runtimeSource, /const targetPolicy = enforceMinimumRRTarget\(\{/);
  assert.match(runtimeSource, /minimumRR: configuredIctMinRR\(\)/);
});

test('build-time adaptive stop metadata can coexist with the R:R contract', () => {
  assert.match(engineSource, /const targetPolicy = enforceMinimumRRTarget\(\{/);
  assert.match(engineSource, /riskModel: adaptiveStop/);
  assert.match(engineSource, /minimumRR: configuredIctMinRR\(\)/);
});

test('Railway startup enforces the authoritative 80% ICT confidence floor without restoring 93%', () => {
  assert.match(
    runtimeSource,
    /process\.env\.ICT_EXECUTION_MIN_CONFIDENCE = String\(Math\.max\(80,/,
  );
  assert.match(
    runtimeSource,
    /Math\.max\(80, parseFloat\(process\.env\.ICT_EXECUTION_MIN_CONFIDENCE \|\| '80'\)\)/,
  );
  assert.doesNotMatch(runtimeSource, /Math\.max\(93/);
  assert.doesNotMatch(runtimeSource, /process\.env\.ICT_MIN_CONFIDENCE/);
});

test('qualified ICT execution uses one authoritative signal and an equality-safe pair spread gate', () => {
  assert.match(executionSource, /authoritativeAnalysis = null/);
  assert.match(executionSource, /executionQualifiedSnapshotGrace/);
  assert.match(executionSource, /usedQualifiedSnapshotGrace/);
  assert.match(executionSource, /const rawFreshSpreadPips =/);
  assert.ok(
    executionSource.includes('ICT_MAX_SPREAD_PIPS_${pair}'),
    'pair-specific spread override marker is missing',
  );
  assert.match(executionSource, /normalizedSpreadPips/);
  assert.match(serverIndexSource, /manualExecution: manualExecution === true/);
  assert.match(serverIndexSource, /signalConfidence, signalRR/);
  assert.match(
    qualifiedRouteSource,
    /signalConfidence: finite\(executionSignal\.confidence\)/,
  );
});

test('ICT execution measures spread from executable OANDA PriceBuckets, never closeout fallback prices', () => {
  const selected = selectExecutableQuote({
    instrument: 'USD_JPY',
    bids: [{ price: '156.866' }],
    asks: [{ price: '156.870' }],
    closeoutBid: '156.850',
    closeoutAsk: '156.887',
  });

  assert.equal(selected.ok, true);
  assert.equal(selected.source, 'top_of_book');
  assert.equal(selected.bid, 156.866);
  assert.equal(selected.ask, 156.870);
  assert.ok(Math.abs(selected.spread - 0.004) < 1e-9);
  assert.match(executionSource, /selectExecutableQuote\(q\)/);
  assert.match(executionSource, /ICT_EXECUTION_QUOTE_RAW/);
  assert.doesNotMatch(executionSource, /q\?\.closeoutBid\s*\?\?/);
  assert.doesNotMatch(executionSource, /q\?\.closeoutAsk\s*\?\?/);
});
