/**
 * server/ftmoClient.js
 *
 * FTMO MetaTrader 5 bridge connector.
 *
 * Signal Stack never connects directly to FTMO or MetaTrader. It calls a
 * user-controlled HTTPS bridge running beside the MT5 terminal on a Windows
 * VPS. Every request is HMAC-signed, account-scoped, and fails closed.
 */

import crypto from 'crypto';

const REQUIRED_FTMO_FIELDS = [
  'accountLogin',
  'server',
  'bridgeUrl',
  'bridgeApiKey',
  'bridgeSecret',
];

const LEGACY_CTRADER_FIELDS = [
  'clientId',
  'clientSecret',
  'accessToken',
  'refreshToken',
];

function truthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function clean(value) {
  return String(value ?? '').trim();
}

function isLocalBridgeHost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

export function normalizeFtmoBridgeUrl(value) {
  const raw = clean(value);
  if (!raw) return '';

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('FTMO MT5 bridge URL must be a valid absolute URL');
  }

  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocalBridgeHost(parsed.hostname))) {
    throw new Error('FTMO MT5 bridge URL must use HTTPS');
  }

  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

export function ftmoConfig(env = process.env) {
  const timeout = Number(env.FTMO_MT5_BRIDGE_TIMEOUT_MS || 8_000);

  return {
    enabled: truthy(env.FTMO_ENABLED),
    provider: clean(env.FTMO_PROVIDER || 'mt5_bridge').toLowerCase(),
    autoTradeEnabled: truthy(env.FTMO_AUTO_TRADE_ENABLED),
    liveExecutionEnabled: truthy(env.FTMO_LIVE_EXECUTION_ENABLED),
    useV3: env.FTMO_USE_V3_ENGINE == null ? true : truthy(env.FTMO_USE_V3_ENGINE),
    useICT: env.FTMO_USE_ICT_ENGINE == null ? true : truthy(env.FTMO_USE_ICT_ENGINE),
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 8_000,
  };
}

export function resolveFtmoCredentials(credentials = null, env = process.env) {
  const stored = credentials && typeof credentials === 'object' ? credentials : {};

  return {
    accountLogin: clean(stored.accountLogin || stored.login || env.FTMO_MT5_LOGIN),
    server: clean(stored.server || env.FTMO_MT5_SERVER),
    bridgeUrl: clean(stored.bridgeUrl || stored.apiBaseUrl || env.FTMO_MT5_BRIDGE_URL),
    bridgeApiKey: clean(stored.bridgeApiKey || env.FTMO_MT5_BRIDGE_API_KEY),
    bridgeSecret: clean(stored.bridgeSecret || env.FTMO_MT5_BRIDGE_SECRET),
    terminalId: clean(stored.terminalId || env.FTMO_MT5_TERMINAL_ID || 'ftmo-primary'),
  };
}

export function validateFtmoCredentials(env = process.env, credentials = null) {
  const config = ftmoConfig(env);

  if (!config.enabled) {
    return { ok: false, error: 'FTMO connector disabled', missing: [] };
  }

  if (config.provider !== 'mt5_bridge') {
    return {
      ok: false,
      error: `Unsupported FTMO provider "${config.provider}"; expected mt5_bridge`,
      missing: [],
    };
  }

  const stored = credentials && typeof credentials === 'object' ? credentials : {};
  const hasLegacyOnlyCredentials = LEGACY_CTRADER_FIELDS.some((field) => clean(stored[field]))
    && !clean(stored.accountLogin || stored.login);

  if (hasLegacyOnlyCredentials) {
    return {
      ok: false,
      error: 'Legacy FTMO cTrader credentials cannot be used by the MT5 bridge. Reconnect the account with MT5 credentials.',
      missing: [...REQUIRED_FTMO_FIELDS],
    };
  }

  const resolved = resolveFtmoCredentials(stored, env);
  const missing = REQUIRED_FTMO_FIELDS.filter((field) => !resolved[field]);

  if (missing.length) {
    return {
      ok: false,
      error: 'FTMO MT5 bridge credentials missing',
      missing,
    };
  }

  if (!/^\d+$/.test(resolved.accountLogin)) {
    return {
      ok: false,
      error: 'FTMO MT5 login must contain digits only',
      missing: [],
    };
  }

  if (resolved.bridgeSecret.length < 16) {
    return {
      ok: false,
      error: 'FTMO MT5 bridge secret must be at least 16 characters',
      missing: [],
    };
  }

  try {
    normalizeFtmoBridgeUrl(resolved.bridgeUrl);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      missing: [],
    };
  }

  return { ok: true, missing: [] };
}

export function buildFtmoClient({ credentials = null, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const config = ftmoConfig(env);
  const validation = validateFtmoCredentials(env, credentials);

  if (!validation.ok) {
    const error = new Error(validation.error || 'FTMO MT5 bridge credentials missing');
    error.missing = validation.missing || [];
    throw error;
  }

  if (typeof fetchImpl !== 'function') {
    throw new Error('FTMO MT5 bridge requires a fetch implementation');
  }

  const resolved = resolveFtmoCredentials(credentials, env);

  return {
    provider: 'ftmo',
    adapter: 'mt5_bridge',
    accountId: resolved.accountLogin,
    environment: clean(credentials?.environment || env.FTMO_ENVIRONMENT || 'challenge'),
    config,
    fetchImpl,
    credentials: {
      accountLogin: resolved.accountLogin,
      server: resolved.server,
      bridgeUrl: normalizeFtmoBridgeUrl(resolved.bridgeUrl),
      bridgeApiKey: resolved.bridgeApiKey,
      bridgeSecret: resolved.bridgeSecret,
      terminalId: resolved.terminalId,
    },
  };
}

function assertFtmoClient(client) {
  if (!client || client.provider !== 'ftmo' || client.adapter !== 'mt5_bridge') {
    throw new Error('Invalid FTMO MT5 bridge client');
  }
}

export function createFtmoBridgeSignature({ timestamp, nonce, body, secret }) {
  return crypto
    .createHmac('sha256', clean(secret))
    .update(`${timestamp}.${nonce}.${body}`)
    .digest('hex');
}

function maskAccount(accountLogin) {
  const value = clean(accountLogin);
  if (value.length <= 6) return value ? `${value.slice(0, 1)}…${value.slice(-1)}` : null;
  return `${value.slice(0, 3)}…${value.slice(-3)}`;
}

function buildBridgePayload(client, payload = {}) {
  return {
    account: {
      login: client.credentials.accountLogin,
      server: client.credentials.server,
      terminalId: client.credentials.terminalId,
    },
    ...payload,
  };
}

async function callFtmoBridge(client, path, payload = {}) {
  assertFtmoClient(client);

  const body = JSON.stringify(buildBridgePayload(client, payload));
  const timestamp = String(Date.now());
  const nonce = crypto.randomUUID();
  const signature = createFtmoBridgeSignature({
    timestamp,
    nonce,
    body,
    secret: client.credentials.bridgeSecret,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), client.config.timeoutMs);

  try {
    const response = await client.fetchImpl(`${client.credentials.bridgeUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-signal-stack-key': client.credentials.bridgeApiKey,
        'x-signal-stack-timestamp': timestamp,
        'x-signal-stack-nonce': nonce,
        'x-signal-stack-signature': signature,
      },
      body,
      signal: controller.signal,
    });

    const text = await response.text();
    let data = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { message: text.slice(0, 500) };
      }
    }

    if (!response.ok) {
      const error = new Error(data?.error || data?.detail || data?.message || `FTMO MT5 bridge returned HTTP ${response.status}`);
      error.status = response.status;
      error.bridgeResponse = data;
      throw error;
    }

    return data && typeof data === 'object' ? data : { ok: true, data };
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`FTMO MT5 bridge timed out after ${client.config.timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function getFtmoDiagnostics(client) {
  assertFtmoClient(client);
  return {
    provider: 'ftmo',
    adapter: 'mt5_bridge',
    accountId: maskAccount(client.accountId),
    server: client.credentials.server,
    bridgeHost: new URL(client.credentials.bridgeUrl).host,
    terminalId: client.credentials.terminalId,
    liveExecutionEnabled: client.config.liveExecutionEnabled,
    autoTradeEnabled: client.config.autoTradeEnabled,
    useV3: client.config.useV3,
    useICT: client.config.useICT,
  };
}

export async function ftmoConnectivityCheck(client) {
  return callFtmoBridge(client, '/v1/health', { operation: 'connectivity_check' });
}

export async function getFtmoAccountSummary(client) {
  return callFtmoBridge(client, '/v1/account/summary');
}

export async function getFtmoPositions(client) {
  return callFtmoBridge(client, '/v1/positions/list');
}

function requirePositiveNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${label} must be greater than 0`);
  }
  return number;
}

export async function placeFtmoOrder(client, order = {}) {
  assertFtmoClient(client);

  if (!client.config.liveExecutionEnabled) {
    return {
      ok: false,
      blocked: true,
      provider: 'ftmo',
      adapter: 'mt5_bridge',
      reason: 'FTMO live execution disabled',
    };
  }

  const symbol = clean(order.symbol);
  const side = clean(order.side).toLowerCase();
  if (!symbol) throw new Error('FTMO order symbol is required');
  if (!['buy', 'sell'].includes(side)) throw new Error('FTMO order side must be buy or sell');

  const normalizedOrder = {
    ...order,
    symbol,
    side,
    volume: requirePositiveNumber(order.volume, 'FTMO order volume'),
  };

  return callFtmoBridge(client, '/v1/orders/place', { order: normalizedOrder });
}

export async function closeFtmoPosition(client, position = {}) {
  assertFtmoClient(client);

  if (!client.config.liveExecutionEnabled) {
    return {
      ok: false,
      blocked: true,
      provider: 'ftmo',
      adapter: 'mt5_bridge',
      reason: 'FTMO live execution disabled',
    };
  }

  const positionId = clean(position.positionId || position.ticket);
  if (!positionId) throw new Error('FTMO positionId is required');

  const normalizedPosition = { ...position, positionId };
  if (position.volume != null && clean(position.volume) !== '') {
    normalizedPosition.volume = requirePositiveNumber(position.volume, 'FTMO close volume');
  }

  return callFtmoBridge(client, '/v1/positions/close', { position: normalizedPosition });
}
