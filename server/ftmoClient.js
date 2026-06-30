/**
 * server/ftmoClient.js
 *
 * FTMO connector scaffold.
 *
 * Important:
 * - FTMO is treated as a prop-firm provider, not as an OANDA account.
 * - Do not silently fall back to OANDA credentials.
 * - Live execution is disabled by default.
 * - cTrader/Open API transport is intentionally separated from the engine logic.
 */

const REQUIRED_FTMO_ENV_KEYS = [
  'FTMO_CTRADER_CLIENT_ID',
  'FTMO_CTRADER_CLIENT_SECRET',
  'FTMO_CTRADER_ACCOUNT_ID',
  'FTMO_CTRADER_ACCESS_TOKEN',
];

export function ftmoConfig(env = process.env) {
  return {
    enabled: String(env.FTMO_ENABLED || 'false').toLowerCase() === 'true',
    provider: String(env.FTMO_PROVIDER || 'ctrader').toLowerCase(),
    autoTradeEnabled: String(env.FTMO_AUTO_TRADE_ENABLED || 'false').toLowerCase() === 'true',
    liveExecutionEnabled: String(env.FTMO_LIVE_EXECUTION_ENABLED || 'false').toLowerCase() === 'true',
    useV3: String(env.FTMO_USE_V3_ENGINE || 'true').toLowerCase() === 'true',
    useICT: String(env.FTMO_USE_ICT_ENGINE || 'true').toLowerCase() === 'true',
  };
}

export function validateFtmoCredentials(env = process.env) {
  const config = ftmoConfig(env);

  if (!config.enabled) {
    return {
      ok: false,
      error: 'FTMO connector disabled',
      missing: [],
    };
  }

  const missing = REQUIRED_FTMO_ENV_KEYS.filter((key) => !String(env[key] || '').trim());

  if (missing.length) {
    return {
      ok: false,
      error: 'FTMO cTrader credentials missing',
      missing,
    };
  }

  return {
    ok: true,
    missing: [],
  };
}

export function buildFtmoClient({ credentials = null, env = process.env } = {}) {
  const config = ftmoConfig(env);

  if (!config.enabled) {
    throw new Error('FTMO connector disabled');
  }

  const validation = validateFtmoCredentials(env);

  if (!validation.ok) {
    const err = new Error(validation.error || 'FTMO cTrader credentials missing');
    err.missing = validation.missing || [];
    throw err;
  }

  const accountId = credentials?.accountId || env.FTMO_CTRADER_ACCOUNT_ID;

  if (!accountId) {
    throw new Error('FTMO cTrader credentials missing');
  }

  return {
    provider: 'ftmo',
    adapter: 'ctrader',
    accountId,
    config,
    credentials: {
      clientId: credentials?.clientId || env.FTMO_CTRADER_CLIENT_ID,
      clientSecret: credentials?.clientSecret || env.FTMO_CTRADER_CLIENT_SECRET,
      accessToken: credentials?.accessToken || env.FTMO_CTRADER_ACCESS_TOKEN,
    },
  };
}

function assertFtmoClient(client) {
  if (!client || client.provider !== 'ftmo' || client.adapter !== 'ctrader') {
    throw new Error('Invalid FTMO client');
  }
}

export async function getFtmoAccountSummary(client) {
  assertFtmoClient(client);

  return {
    ok: false,
    provider: 'ftmo',
    adapter: 'ctrader',
    reason: 'FTMO cTrader account summary transport not implemented yet',
  };
}

export async function getFtmoPositions(client) {
  assertFtmoClient(client);

  return {
    ok: false,
    provider: 'ftmo',
    adapter: 'ctrader',
    reason: 'FTMO cTrader positions transport not implemented yet',
  };
}

export async function placeFtmoOrder(client, order = {}) {
  assertFtmoClient(client);

  if (!client.config.liveExecutionEnabled) {
    return {
      ok: false,
      blocked: true,
      provider: 'ftmo',
      reason: 'FTMO live execution disabled',
    };
  }

  return {
    ok: false,
    blocked: true,
    provider: 'ftmo',
    reason: 'FTMO cTrader order transport not implemented yet',
    order,
  };
}

export async function closeFtmoPosition(client, position = {}) {
  assertFtmoClient(client);

  if (!client.config.liveExecutionEnabled) {
    return {
      ok: false,
      blocked: true,
      provider: 'ftmo',
      reason: 'FTMO live execution disabled',
    };
  }

  return {
    ok: false,
    blocked: true,
    provider: 'ftmo',
    reason: 'FTMO cTrader close-position transport not implemented yet',
    position,
  };
}
