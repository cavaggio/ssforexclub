import test from 'node:test';
import assert from 'node:assert/strict';

import { ICT_MARKET_MAKER_STAGES } from './ictMarketMakerModel.js';
import {
  __resetIctMarketMakerStateForTests,
  ictNewYorkDateKey,
  initializeIctMarketMakerStudy,
  loadIctMarketMakerContext,
  persistIctMarketMakerCycle,
} from './ictMarketMakerState.js';

test('the 02:00 study initializes and persists the pair Power-of-Three cycle', async () => {
  const saved = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
  delete process.env.SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  __resetIctMarketMakerStateForTests();

  try {
    const client = { accountId: 'state-test', environment: 'practice' };
    const now = new Date('2026-06-04T06:05:00.000Z');
    assert.equal(ictNewYorkDateKey(now), '2026-06-04');

    const initialized = await initializeIctMarketMakerStudy({
      client,
      pair: 'EUR_USD',
      now,
      study: {
        study_date: '2026-06-04',
        studied_at: now.toISOString(),
        engine_analysis: {
          ictBias: 'bullish',
          timeframeBias: { d1: 'bullish', h4: 'bullish' },
        },
        feature_snapshot: { bodyRatio: 0.42 },
      },
    });
    assert.equal(initialized.studyReady, true);
    assert.equal(initialized.cycle.stage, ICT_MARKET_MAKER_STAGES.STUDIED);
    assert.equal(initialized.cycle.direction, 'bullish');

    const advancedCycle = {
      ...initialized.cycle,
      stage: ICT_MARKET_MAKER_STAGES.KEY_TAPPED,
      keyLevel: { source: 'previous_day_low', tappedAt: '2026-06-04T06:25:00.000Z' },
    };
    await persistIctMarketMakerCycle({
      client,
      pair: 'EUR_USD',
      context: initialized,
      cycle: advancedCycle,
    });

    const reloaded = await loadIctMarketMakerContext({ client, pair: 'EUR_USD', now });
    assert.equal(reloaded.studyReady, true);
    assert.equal(reloaded.cycle.stage, ICT_MARKET_MAKER_STAGES.KEY_TAPPED);
    assert.equal(reloaded.featureSnapshot.bodyRatio, 0.42);
  } finally {
    __resetIctMarketMakerStateForTests();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
