import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFtmoClient,
  ftmoConfig,
  getFtmoAccountSummary,
  getFtmoPositions,
  placeFtmoOrder,
  closeFtmoPosition,
  validateFtmoCredentials,
} from './ftmoClient.js';

const validFtmoEnv = {
  FTMO_ENABLED: 'true',
  FTMO_PROVIDER: 'ctrader',
  FTMO_AUTO_TRADE_ENABLED: 'false',
  FTMO_LIVE_EXECUTION_ENABLED: 'false',
  FTMO_USE_V3_ENGINE: 'true',
  FTMO_USE_ICT_ENGINE: 'true',
  FTMO_CTRADER_CLIENT_ID: 'client-id',
  FTMO_CTRADER_CLIENT_SECRET: 'client-secret',
  FTMO_CTRADER_ACCOUNT_ID: 'account-id',
  FTMO_CTRADER_ACCESS_TOKEN: 'access-token',
};

test('FTMO config defaults live execution to false', () => {
  const config = ftmoConfig({
    FTMO_ENABLED: 'true',
    FTMO_PROVIDER: 'ctrader',
  });

  assert.equal(config.enabled, true);
  assert.equal(config.provider, 'ctrader');
  assert.equal(config.liveExecutionEnabled, false);
  assert.equal(config.useV3, true);
  assert.equal(config.useICT, true);
});

test('FTMO validation rejects disabled connector', () => {
  const result = validateFtmoCredentials({
    FTMO_ENABLED: 'false',
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'FTMO connector disabled');
});

test('FTMO validation rejects missing cTrader credentials', () => {
  const result = validateFtmoCredentials({
    FTMO_ENABLED: 'true',
    FTMO_PROVIDER: 'ctrader',
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'FTMO cTrader credentials missing');
  assert.ok(result.missing.includes('FTMO_CTRADER_CLIENT_ID'));
  assert.ok(result.missing.includes('FTMO_CTRADER_CLIENT_SECRET'));
  assert.ok(result.missing.includes('FTMO_CTRADER_ACCOUNT_ID'));
  assert.ok(result.missing.includes('FTMO_CTRADER_ACCESS_TOKEN'));
});

test('FTMO client builds only from FTMO credentials', () => {
  const client = buildFtmoClient({ env: validFtmoEnv });

  assert.equal(client.provider, 'ftmo');
  assert.equal(client.adapter, 'ctrader');
  assert.equal(client.accountId, 'account-id');
  assert.equal(client.credentials.clientId, 'client-id');
});

test('FTMO client does not accept OANDA-only credentials', () => {
  assert.throws(
    () => buildFtmoClient({
      env: {
        FTMO_ENABLED: 'true',
        OANDA_API_KEY: 'oanda-key',
        OANDA_ACCOUNT_ID: 'oanda-account',
      },
    }),
    /FTMO cTrader credentials missing/,
  );
});

test('FTMO live execution false blocks place order', async () => {
  const client = buildFtmoClient({ env: validFtmoEnv });
  const result = await placeFtmoOrder(client, {
    symbol: 'EUR_USD',
    side: 'buy',
  });

  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.equal(result.reason, 'FTMO live execution disabled');
});

test('FTMO live execution false blocks close position', async () => {
  const client = buildFtmoClient({ env: validFtmoEnv });
  const result = await closeFtmoPosition(client, {
    positionId: 'position-1',
  });

  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.equal(result.reason, 'FTMO live execution disabled');
});

test('FTMO account summary transport is isolated and not silently implemented', async () => {
  const client = buildFtmoClient({ env: validFtmoEnv });
  const result = await getFtmoAccountSummary(client);

  assert.equal(result.ok, false);
  assert.equal(result.provider, 'ftmo');
  assert.equal(result.reason, 'FTMO cTrader account summary transport not implemented yet');
});

test('FTMO positions transport is isolated and not silently implemented', async () => {
  const client = buildFtmoClient({ env: validFtmoEnv });
  const result = await getFtmoPositions(client);

  assert.equal(result.ok, false);
  assert.equal(result.provider, 'ftmo');
  assert.equal(result.reason, 'FTMO cTrader positions transport not implemented yet');
});
