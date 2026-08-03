import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  configuredIctWatchlist,
  DEFAULT_ICT_WATCHLIST,
  ICT_EXECUTABLE_WATCHLIST,
  ICT_ANALYSIS_ONLY_WATCHLIST,
  isIctAnalysisOnlyInstrument,
  isIctExecutionEligibleInstrument,
} from './ictWatchlist.js';
import { getIctInstrumentMeta } from './ictInstrumentCatalog.js';
import { aggregateCandles, parseYahooChart } from './ictMarketData.js';

const REQUIRED_ICT_INSTRUMENTS = [
  'EUR_USD',
  'GBP_USD',
  'USD_JPY',
  'GBP_JPY',
  'XAU_USD',
  'US30_USD',
  'SPX500_USD',
];

test('ICT watchlist includes four executable FX pairs and three signal-only instruments', () => {
  assert.deepEqual(DEFAULT_ICT_WATCHLIST, REQUIRED_ICT_INSTRUMENTS);
  assert.deepEqual(configuredIctWatchlist(), REQUIRED_ICT_INSTRUMENTS);
  assert.deepEqual(ICT_EXECUTABLE_WATCHLIST, ['EUR_USD', 'GBP_USD', 'USD_JPY', 'GBP_JPY']);
  assert.deepEqual(ICT_ANALYSIS_ONLY_WATCHLIST, ['XAU_USD', 'US30_USD', 'SPX500_USD']);
});

test('stale environment variables cannot alter the approved ICT universe', () => {
  assert.deepEqual(configuredIctWatchlist({
    ICT_PAIRS: 'EUR_USD,USD_CAD,NAS100_USD',
    FOREX_WATCHLIST: 'AUD_USD,NZD_USD',
  }), REQUIRED_ICT_INSTRUMENTS);
});

test('gold and indices are signals only and cannot use OANDA execution', () => {
  for (const instrument of ICT_ANALYSIS_ONLY_WATCHLIST) {
    assert.equal(isIctAnalysisOnlyInstrument(instrument), true);
    assert.equal(isIctExecutionEligibleInstrument(instrument), false);
    assert.equal(getIctInstrumentMeta(instrument).executionEligible, false);
  }
  assert.equal(isIctExecutionEligibleInstrument('EUR_USD'), true);
});

test('requested dashboard labels and market-data proxy symbols are canonical', () => {
  assert.deepEqual(
    ['XAU_USD', 'US30_USD', 'SPX500_USD'].map((instrument) => {
      const meta = getIctInstrumentMeta(instrument);
      return [meta.displaySymbol, meta.sourceSymbol, meta.dataSource];
    }),
    [
      ['XAU/USD', 'GC=F', 'yahoo'],
      ['US30', 'YM=F', 'yahoo'],
      ['US500', 'ES=F', 'yahoo'],
    ],
  );
});

test('Yahoo chart candles normalize and aggregate to four-hour candles', () => {
  const start = 1_700_000_000;
  const payload = {
    chart: {
      result: [{
        timestamp: [start, start + 3600, start + 7200, start + 10800],
        indicators: {
          quote: [{
            open: [100, 101, 102, 103],
            high: [102, 103, 104, 105],
            low: [99, 100, 101, 102],
            close: [101, 102, 103, 104],
            volume: [10, 20, 30, 40],
          }],
        },
      }],
      error: null,
    },
  };
  const hourly = parseYahooChart(payload);
  assert.equal(hourly.length, 4);
  const h4 = aggregateCandles(hourly, 4);
  assert.ok(h4.length >= 1);
  assert.equal(h4[0].open, 100);
  assert.equal(h4.at(-1).close, 104);
  assert.equal(h4.reduce((sum, candle) => sum + candle.volume, 0), 100);
});

test('ICT engine and executors are enforced through the analysis router and eligibility policy', () => {
  const engine = readFileSync(new URL('./ictEngine.js', import.meta.url), 'utf8');
  const execution = readFileSync(new URL('./ictExecution.js', import.meta.url), 'utf8');
  const autoTrade = readFileSync(new URL('./ictAutoTrade.js', import.meta.url), 'utf8');

  assert.match(engine, /import \{ getIctCandles \} from '\.\/ictMarketData\.js';/);
  assert.match(engine, /const ICT_PAIRS = configuredIctWatchlist\(\);/);
  assert.match(engine, /executionEligible: instrumentMeta\.executionEligible/);
  assert.doesNotMatch(engine, /getCandles\(pair, g, n, \{ client \}\)/);

  assert.match(execution, /isIctExecutionEligibleInstrument\(pair\)/);
  assert.match(execution, /signal-only in ICT Intelligence/);
  assert.match(autoTrade, /isIctExecutionEligibleInstrument\(analysis\.pair\)/);
});
