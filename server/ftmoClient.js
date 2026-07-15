/**
 * server/ftmoClient.js
 *
 * FTMO cTrader Open API connector boundary.
 *
 * Important:
 * - FTMO is treated as a prop-firm provider, not as an OANDA account.
 * - Signal Stack owns the cTrader Open API app client ID/secret.
 * - Each user authorizes their own cTrader accounts through OAuth and their
 *   encrypted access/refresh tokens are supplied per request.
 * - Live execution remains disabled by default.
 */

function firstValue(...values) {
  return values.map((value) => String(value || '').trim()).find(Boolean) || '';
}

function resolveAppCredentials(env = process.env) {
  return {
    clientId: firstValue(env.CTRADER_OPEN_API_CLIENT_ID, env.FTMO_CTRADER_CLIENT_ID),
    clientSecret: firstValue(env.CTRADER_OPEN_API_CLIENT_SECRET, env.FTMO_CTRADER_CLIENT_SECRET),
  };
}

function resolveAccountCredentials(credentials = null, env = process.env) {
  return {
    accountId: firstValue(credentials?.accountId, env.FTMO_CTRADER_ACCOUNT_ID),
    accessToken: firstValue(credentials?.accessToken, env.FTMO_CTRADER_ACCESS_TOKEN),
    refreshToken: firstValue(credentials?.refreshToken, env.FTMO_CTRADER_REFRESH_TOKEN),
    traderLogin: credentials?.traderLogin == null ? null : String(credentials.traderLogin),
    isLive: Boolean(credentials?.isLive),
  };
}

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

/**
 * With no credential object this validates the shared Signal Stack cTrader app.
 * With a credential object it also validates the selected user's account token.
 */
export function validateFtmoCredentials(env = process.env, credentials = null) {
  const config = ftmoConfig(env);

  if (!config.enabled) {
    return { ok: false, error: 'FTMO connector disabled', missing: [] };
  }

  if (config.provider !== 'ctrader') {
    return { ok: false, error: `Unsupported FTMO provider: ${config.provider}`, missing: ['FTMO_PROVIDER=ctrader'] };
  }

  const app = resolveAppCredentials(env);
  const missing = [];
  if (!app.clientId) missing.push('CTRADER_OPEN_API_CLIENT_ID');
  if (!app.clientSecret) missing.push('CTRADER_OPEN_API_CLIENT_SECRET');

  const hasAccountInput = Boolean(
    credentials || env.FTMO_CTRADER_ACCOUNT_ID || env.FTMO_CTRADER_ACCESS_TOKEN || env.FTMO_CTRADER_REFRESH_TOKEN,
  );

  if (hasAccountInput) {
    const account = resolveAccountCredentials(credentials, env);
    if (!account.accountId) missing.push('accountId');
    if (!account.accessToken) missing.push('accessToken');
    if (!account.refreshToken) missing.push('refreshToken');
  }

  if (missing.length) {
    return {
      ok: false,
      error: hasAccountInput ? 'FTMO cTrader credentials missing' : 'cTrader Open API app credentials missing',
      missing,
    };
  }

  return { ok: true, missing: [] };
}

export function buildFtmoClient({ credentials = null, env = process.env } = {}) {
  const config = ftmoConfig(env);
  const accountCredentials = resolveAccountCredentials(credentials, env);
  const validation = validateFtmoCredentials(env, accountCredentials);

  if (!validation.ok) {
    const err = new Error(validation.error || 'FTMO cTrader credentials missing');
    err.missing = validation.missing || [];
    throw err;
  }

  const app = resolveAppCredentials(env);

  return {
    provider: 'ftmo',
    adapter: 'ctrader',
    accountId: accountCredentials.accountId,
    config,
    credentials: {
      clientId: app.clientId,
      clientSecret: app.clientSecret,
      accessToken: accountCredentials.accessToken,
      refreshToken: accountCredentials.refreshToken,
      traderLogin: accountCredentials.traderLogin,
      isLive: accountCredentials.isLive,
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
