import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFtmoClient,
  closeFtmoPosition,
  createFtmoBridgeSignature,
  ftmoConfig,
  ftmoConnectivityCheck,
  getFtmoAccountSummary,
  getFtmoDiagnostics,
  getFtmoPositions,
  normalizeFtmoBridgeUrl,
  placeFtmoOrder,
  validateFtmoCredentials,
} from './ftmoClient.js';

const validFtmoEnv = {
  FTMO_ENABLED: 'true',
  FTMO_PROVIDER: 'mt5_bridge',
  FTMO_AUTO_TRADE_ENABLED: 'false',
  FTMO_LIVE_EXECUTION_ENABLED: 'false',
  FTMO_USE_V3_ENGINE: 'true',
  FTMO_USE_ICT_ENGINE: 'true',
  FTMO_MT5_LOGIN: '12345678',
  FTMO_MT5_SERVER: 'FTMO-Demo2',
  FTMO_MT5_BRIDGE_URL: 'https://mt5.example.com',
  FTMO_MT5_BRIDGE_API_KEY: 'bridge-key',
  FTMO_MT5_BRIDGE_SECRET: 'bridge-secret-with-32-characters',
  FTMO_MT5_TERMINAL_ID: 'ftmo-primary',
};

function fakeResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(data); },
  };
}

test('FTMO config defaults to MT5 bridge and live execution false', () => {
  const config = ftmoConfig({ FTMO_ENABLED: 'true' });
  assert.equal(config.enabled, true);
  assert.equal(config.provider, 'mt5_bridge');
  assert.equal(config.liveExecutionEnabled, false);
  assert.equal(config.useV3, true);
  assert.equal(config.useICT, true);
});

test('FTMO validation rejects disabled connector', () => {
  const result = validateFtmoCredentials({ FTMO_ENABLED: 'false' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'FTMO connector disabled');
});

test('FTMO validation rejects missing MT5 bridge credentials', () => {
  const result = validateFtmoCredentials({
    FTMO_ENABLED: 'true',
    FTMO_PROVIDER: 'mt5_bridge',
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'FTMO MT5 bridge credentials missing');
  assert.ok(result.missing.includes('accountLogin'));
  assert.ok(result.missing.includes('server'));
  assert.ok(result.missing.includes('bridgeUrl'));
  assert.ok(result.missing.includes('bridgeApiKey'));
  assert.ok(result.missing.includes('bridgeSecret'));
});

test('legacy cTrader credentials require reconnection', () => {
  const result = validateFtmoCredentials(
    { FTMO_ENABLED: 'true', FTMO_PROVIDER: 'mt5_bridge' },
    { clientId: 'old-client', accessToken: 'old-token' },
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /Legacy FTMO cTrader credentials/);
});

test('FTMO client builds from encrypted per-user MT5 bridge credentials', () => {
  const client = buildFtmoClient({
    env: { FTMO_ENABLED: 'true', FTMO_PROVIDER: 'mt5_bridge' },
    credentials: {
      accountLogin: '87654321',
      server: 'FTMO-Server',
      bridgeUrl: 'https://bridge.example.com/',
      bridgeApiKey: 'key',
      bridgeSecret: '1234567890abcdef1234567890abcdef',
      terminalId: 'terminal-2',
    },
  });
  assert.equal(client.provider, 'ftmo');
  assert.equal(client.adapter, 'mt5_bridge');
  assert.equal(client.accountId, '87654321');
  assert.equal(client.credentials.bridgeUrl, 'https://bridge.example.com');
});

test('FTMO client does not accept OANDA-only credentials', () => {
  assert.throws(
    () => buildFtmoClient({
      env: {
        FTMO_ENABLED: 'true',
        FTMO_PROVIDER: 'mt5_bridge',
        OANDA_API_KEY: 'oanda-key',
        OANDA_ACCOUNT_ID: 'oanda-account',
      },
    }),
    /FTMO MT5 bridge credentials missing/,
  );
});

test('bridge URL requires HTTPS except localhost', () => {
  assert.equal(normalizeFtmoBridgeUrl('https://bridge.example.com/'), 'https://bridge.example.com');
  assert.equal(normalizeFtmoBridgeUrl('http://127.0.0.1:8787/'), 'http://127.0.0.1:8787');
  assert.throws(() => normalizeFtmoBridgeUrl('http://bridge.example.com'), /must use HTTPS/);
});

test('signature is deterministic', () => {
  const signature = createFtmoBridgeSignature({
    timestamp: '1000',
    nonce: 'abc',
    body: '{"ok":true}',
    secret: '1234567890abcdef',
  });
  assert.equal(signature, '6a2f56c13ff6667ac289e61320441cb288682079f9a3307db46cdf918e1165c8');
});

test('FTMO live execution false blocks place and close requests', async () => {
  const client = buildFtmoClient({ env: validFtmoEnv });
  const orderResult = await placeFtmoOrder(client, { symbol: 'EURUSD', side: 'buy', volume: 0.1 });
  const closeResult = await closeFtmoPosition(client, { positionId: '123' });
  assert.equal(orderResult.blocked, true);
  assert.equal(closeResult.blocked, true);
  assert.equal(orderResult.reason, 'FTMO live execution disabled');
});

test('connectivity check signs and sends an account-scoped request', async () => {
  let captured;
  const client = buildFtmoClient({
    env: validFtmoEnv,
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return fakeResponse({ ok: true, terminalConnected: true });
    },
  });
  const result = await ftmoConnectivityCheck(client);
  assert.equal(result.ok, true);
  assert.equal(captured.url, 'https://mt5.example.com/v1/health');
  assert.ok(captured.options.headers['x-signal-stack-signature']);
  assert.equal(captured.options.headers['x-signal-stack-key'], 'bridge-key');
  const body = JSON.parse(captured.options.body);
  assert.equal(body.account.login, '12345678');
  assert.equal(body.account.server, 'FTMO-Demo2');
  assert.equal(body.account.terminalId, 'ftmo-primary');
});

test('account and positions use MT5 bridge transport', async () => {
  const calls = [];
  const client = buildFtmoClient({
    env: validFtmoEnv,
    fetchImpl: async (url) => {
      calls.push(url);
      return fakeResponse({ ok: true });
    },
  });
  await getFtmoAccountSummary(client);
  await getFtmoPositions(client);
  assert.deepEqual(calls, [
    'https://mt5.example.com/v1/account/summary',
    'https://mt5.example.com/v1/positions/list',
  ]);
});

test('live order and close use bridge endpoints', async () => {
  const calls = [];
  const client = buildFtmoClient({
    env: { ...validFtmoEnv, FTMO_LIVE_EXECUTION_ENABLED: 'true' },
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return fakeResponse({ ok: true, ticket: 77 });
    },
  });
  await placeFtmoOrder(client, { symbol: 'EURUSD', side: 'BUY', volume: 0.1, stopLoss: 1.1, takeProfit: 1.2 });
  await closeFtmoPosition(client, { positionId: '77', volume: 0.05 });
  assert.equal(calls[0].url, 'https://mt5.example.com/v1/orders/place');
  assert.equal(calls[0].body.order.side, 'buy');
  assert.equal(calls[1].url, 'https://mt5.example.com/v1/positions/close');
  assert.equal(calls[1].body.position.positionId, '77');
});

test('diagnostics never expose bridge secrets', () => {
  const diagnostics = getFtmoDiagnostics(buildFtmoClient({ env: validFtmoEnv }));
  assert.equal(diagnostics.adapter, 'mt5_bridge');
  assert.equal(diagnostics.accountId, '123…678');
  assert.equal(diagnostics.bridgeHost, 'mt5.example.com');
  assert.equal('bridgeSecret' in diagnostics, false);
  assert.equal('bridgeApiKey' in diagnostics, false);
});
