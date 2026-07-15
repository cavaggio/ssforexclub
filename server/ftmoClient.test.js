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
  CTRADER_OPEN_API_CLIENT_ID: 'client-id',
  CTRADER_OPEN_API_CLIENT_SECRET: 'client-secret',
};

const validUserCredentials = {
  accountId: 'account-id',
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  traderLogin: '1234567',
  isLive: false,
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
  const result = validateFtmoCredentials({ FTMO_ENABLED: 'false' });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'FTMO connector disabled');
});

test('FTMO app validation requires Signal Stack cTrader app credentials', () => {
  const result = validateFtmoCredentials({
    FTMO_ENABLED: 'true',
    FTMO_PROVIDER: 'ctrader',
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'cTrader Open API app credentials missing');
  assert.ok(result.missing.includes('CTRADER_OPEN_API_CLIENT_ID'));
  assert.ok(result.missing.includes('CTRADER_OPEN_API_CLIENT_SECRET'));
});

test('FTMO app validation succeeds without a global user account token', () => {
  const result = validateFtmoCredentials(validFtmoEnv);

  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
});

test('FTMO client builds from shared app credentials and per-user OAuth tokens', () => {
  const client = buildFtmoClient({
    env: validFtmoEnv,
    credentials: validUserCredentials,
  });

  assert.equal(client.provider, 'ftmo');
  assert.equal(client.adapter, 'ctrader');
  assert.equal(client.accountId, 'account-id');
  assert.equal(client.credentials.clientId, 'client-id');
  assert.equal(client.credentials.accessToken, 'access-token');
  assert.equal(client.credentials.refreshToken, 'refresh-token');
});

test('FTMO client rejects missing per-user OAuth tokens', () => {
  assert.throws(
    () => buildFtmoClient({ env: validFtmoEnv }),
    /FTMO cTrader credentials missing/,
  );
});

test('FTMO client does not accept OANDA-only credentials', () => {
  assert.throws(
    () => buildFtmoClient({
      env: {
        ...validFtmoEnv,
        OANDA_API_KEY: 'oanda-key',
        OANDA_ACCOUNT_ID: 'oanda-account',
      },
    }),
    /FTMO cTrader credentials missing/,
  );
});

test('FTMO live execution false blocks place order', async () => {
  const client = buildFtmoClient({ env: validFtmoEnv, credentials: validUserCredentials });
  const result = await placeFtmoOrder(client, {
    symbol: 'EUR_USD',
    side: 'buy',
  });

  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.equal(result.reason, 'FTMO live execution disabled');
});

test('FTMO live execution false blocks close position', async () => {
  const client = buildFtmoClient({ env: validFtmoEnv, credentials: validUserCredentials });
  const result = await closeFtmoPosition(client, {
    positionId: 'position-1',
  });

  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.equal(result.reason, 'FTMO live execution disabled');
});

test('FTMO account summary transport remains isolated until implemented', async () => {
  const client = buildFtmoClient({ env: validFtmoEnv, credentials: validUserCredentials });
  const result = await getFtmoAccountSummary(client);

  assert.equal(result.ok, false);
  assert.equal(result.provider, 'ftmo');
  assert.equal(result.reason, 'FTMO cTrader account summary transport not implemented yet');
});

test('FTMO positions transport remains isolated until implemented', async () => {
  const client = buildFtmoClient({ env: validFtmoEnv, credentials: validUserCredentials });
  const result = await getFtmoPositions(client);

  assert.equal(result.ok, false);
  assert.equal(result.provider, 'ftmo');
  assert.equal(result.reason, 'FTMO cTrader positions transport not implemented yet');
});
