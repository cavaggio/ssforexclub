/**
 * server/ninjatraderClient.js
 *
 * NinjaTrader futures connector. Entirely separate from the OANDA forex client
 * (server/oandaClient.js) — there is no shared transport, no shared base URL,
 * and the provider guard (server/providerRouting.js) prevents cross-execution.
 *
 * Credential shape (multi-field, stored AES-256-GCM-encrypted as a JSON blob):
 *   { name, password, appId, appVersion, cid, sec }
 *
 * Live execution is OFF by default and gated by two flags:
 *   NINJATRADER_FUTURES_ENABLED          — master switch for the provider
 *   NINJATRADER_LIVE_EXECUTION_ENABLED   — required additionally for env='live'
 * Sim/paper requires only the master switch.
 *
 * Network calls go through an injected `fetchImpl` (defaults to global fetch)
 * so the connector is unit-testable without a live gateway.
 */

import { PROVIDERS } from './providerRouting.js';

export const NINJATRADER_PROVIDER = PROVIDERS.NINJATRADER;

const REQUIRED_FIELDS = ['name', 'password', 'appId', 'appVersion', 'cid', 'sec'];

export function ninjaTraderFuturesEnabled() {
  return String(process.env.NINJATRADER_FUTURES_ENABLED || 'false').toLowerCase() === 'true';
}

export function ninjaTraderLiveExecutionEnabled() {
  return String(process.env.NINJATRADER_LIVE_EXECUTION_ENABLED || 'false').toLowerCase() === 'true';
}

// NinjaTrader retail order routing uses the Tradovate REST API. The credential
// set {name,password,appId,appVersion,cid,sec} is exactly Tradovate's
// /auth/accesstokenrequest body. Paper/sim and live are DIFFERENT hosts, so the
// base URL is chosen per environment — never mixed.
function baseUrlForMode(mode) {
  if (mode === 'live') {
    return process.env.TRADOVATE_LIVE_URL || 'https://live.tradovateapi.com/v1';
  }
  return process.env.TRADOVATE_DEMO_URL || 'https://demo.tradovateapi.com/v1';
}

/**
 * Pure credential-shape validation — no network. Returns { ok, missing, error }.
 * Used both by the connect form (server action) and before any order is built.
 */
export function validateNinjaTraderCredentials(credentials) {
  if (!credentials || typeof credentials !== 'object') {
    return { ok: false, missing: [...REQUIRED_FIELDS], error: 'Credentials object is required' };
  }
  const missing = REQUIRED_FIELDS.filter((f) => {
    const v = credentials[f];
    return v == null || String(v).trim() === '';
  });
  if (missing.length > 0) {
    return { ok: false, missing, error: `Missing required field(s): ${missing.join(', ')}` };
  }
  return { ok: true, missing: [] };
}

/**
 * Build a per-request NinjaTrader client. Carries the provider tag so the
 * routing guard can assert it, the resolved mode, and an injected fetch.
 */
export function buildNinjaTraderClient({ credentials, environment = 'sim', fetchImpl, baseUrl } = {}) {
  const check = validateNinjaTraderCredentials(credentials);
  if (!check.ok) throw new Error(`buildNinjaTraderClient: ${check.error}`);
  if (!ninjaTraderFuturesEnabled()) {
    throw new Error('NinjaTrader provider is disabled (set NINJATRADER_FUTURES_ENABLED=true)');
  }

  const mode = environment === 'live' ? 'live' : 'sim';
  const doFetch = fetchImpl || globalThis.fetch;
  const root = (baseUrl || baseUrlForMode(mode)).replace(/\/+$/, '');

  let sessionToken = null;

  async function call(path, { method = 'GET', body } = {}) {
    if (typeof doFetch !== 'function') {
      throw new Error('NinjaTrader connector: no fetch implementation available');
    }
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (sessionToken) headers.Authorization = `Bearer ${sessionToken}`;
    const res = await doFetch(`${root}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = typeof res.text === 'function' ? await res.text() : '';
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* keep null */ }
    if (!res.ok) {
      const detail = (data && (data.errorText || data.error)) || text || `HTTP ${res.status}`;
      const err = new Error(`Tradovate API error: ${detail}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  return {
    provider: NINJATRADER_PROVIDER,
    mode,
    baseUrl: root,
    /**
     * Tradovate access-token request. The body field names MUST match exactly
     * (name, password, appId, appVersion, cid, sec) — no renaming. A successful
     * response carries accessToken; a failure carries errorText, and a throttle
     * response carries a p-ticket (treated as a failed auth here).
     */
    async authenticate() {
      const data = await call('/auth/accesstokenrequest', {
        method: 'POST',
        body: {
          name: credentials.name,
          password: credentials.password,
          appId: credentials.appId,
          appVersion: credentials.appVersion,
          cid: credentials.cid,
          sec: credentials.sec,
        },
      });
      sessionToken = (data && data.accessToken) || null;
      const ok = Boolean(sessionToken) && !(data && (data.errorText || data['p-ticket']));
      // Safe log: host + outcome only, never the token or any credential.
      try {
        const host = new URL(root).host;
        console.log(`[TRADOVATE AUTH] host=${host} mode=${mode} tokenReceived=${ok ? 'yes' : 'no'}`);
      } catch { /* ignore */ }
      return { ok, mode, reason: data && data.errorText ? data.errorText : null };
    },
    call,
  };
}

/** Validate credentials against the live gateway (shape check + auth probe). */
export async function ninjaTraderConnectivityCheck({ credentials, environment, fetchImpl, baseUrl } = {}) {
  const shape = validateNinjaTraderCredentials(credentials);
  if (!shape.ok) return { ok: false, status: 'invalid', error: shape.error, missing: shape.missing };
  try {
    const client = buildNinjaTraderClient({ credentials, environment, fetchImpl, baseUrl });
    const auth = await client.authenticate();
    return auth.ok
      ? { ok: true, status: 'valid', mode: client.mode }
      : { ok: false, status: 'invalid', error: 'Authentication rejected by gateway' };
  } catch (err) {
    return { ok: false, status: 'invalid', error: err?.message || String(err) };
  }
}

function toNum(v) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Run a full safe diagnostic: validate fields → authenticate → fetch accounts +
 * positions. NEVER throws on auth failure or bad credentials — returns a coded
 * result instead. NEVER returns secrets/tokens. This is what the dashboard
 * connection panel reads through the proxy.
 */
export async function getNinjaTraderDiagnostics({ credentials, environment, fetchImpl, baseUrl } = {}) {
  const shape = validateNinjaTraderCredentials(credentials);
  if (!shape.ok) {
    return { ok: false, code: 'BROKER_AUTH_FAILED', validationStatus: 'invalid', message: shape.error, missing: shape.missing };
  }
  if (!ninjaTraderFuturesEnabled()) {
    return { ok: false, code: 'CONNECTOR_DISABLED', validationStatus: 'unvalidated', message: 'NinjaTrader provider is disabled.' };
  }

  let client;
  try {
    client = buildNinjaTraderClient({ credentials, environment, fetchImpl, baseUrl });
  } catch (err) {
    return { ok: false, code: 'CONNECTOR_DISABLED', validationStatus: 'unvalidated', message: err?.message || 'Connector unavailable' };
  }

  try {
    const auth = await client.authenticate();
    if (!auth.ok) {
      return { ok: false, code: 'BROKER_AUTH_FAILED', validationStatus: 'invalid', message: 'NinjaTrader / Tradovate authentication failed.' };
    }
  } catch {
    // Broker rejected creds or gateway error during auth — coded, never raw.
    return { ok: false, code: 'BROKER_AUTH_FAILED', validationStatus: 'invalid', message: 'NinjaTrader / Tradovate authentication failed.' };
  }

  let accounts = [];
  let positions = [];
  try {
    accounts = await getNinjaTraderAccounts(client);
    positions = await getNinjaTraderPositions(client, {});
  } catch {
    // Auth succeeded but data fetch failed — still "valid", just no data.
    accounts = [];
    positions = [];
  }

  const sel = accounts[0] || null;
  const envIsLive = client.mode === 'live';
  return {
    ok: true,
    code: accounts.length ? 'OK' : 'NO_ACCOUNTS',
    validationStatus: 'valid',
    environment: envIsLive ? 'live' : 'paper',
    accountMode: envIsLive ? 'live' : 'simulated',
    accountCount: accounts.length,
    selectedAccount: sel ? String(sel.name ?? sel.id ?? '') || null : null,
    balance: sel ? toNum(sel.balance) : null,
    equity: sel ? toNum(sel.equity) : null,
    openPositions: positions.length,
    // Backend's view of whether an order COULD execute (flag + live account).
    executionAllowed: envIsLive && ninjaTraderLiveExecutionEnabled(),
  };
}

export async function getNinjaTraderAccounts(client) {
  if (!client || client.provider !== NINJATRADER_PROVIDER) {
    throw new Error('getNinjaTraderAccounts: client is not a NinjaTrader client');
  }
  // Tradovate: GET /account/list returns an array of account objects.
  const data = await client.call('/account/list', { method: 'GET' });
  return Array.isArray(data) ? data : (data && data.accounts) || [];
}

export async function getNinjaTraderPositions(client) {
  if (!client || client.provider !== NINJATRADER_PROVIDER) {
    throw new Error('getNinjaTraderPositions: client is not a NinjaTrader client');
  }
  const data = await client.call('/position/list', { method: 'GET' });
  return Array.isArray(data) ? data : (data && data.positions) || [];
}

/**
 * Place a futures order. HARD-GATED: live requires NINJATRADER_LIVE_EXECUTION_ENABLED.
 * Returns { ok:false, blocked:true, reason } rather than executing when a gate fails.
 */
export async function placeNinjaTraderOrder(client, order = {}) {
  if (!client || client.provider !== NINJATRADER_PROVIDER) {
    throw new Error('placeNinjaTraderOrder: client is not a NinjaTrader client');
  }
  if (client.mode === 'live' && !ninjaTraderLiveExecutionEnabled()) {
    return {
      ok: false,
      blocked: true,
      reason: 'NinjaTrader live execution is disabled (set NINJATRADER_LIVE_EXECUTION_ENABLED=true)',
    };
  }
  // Tradovate: POST /order/placeorder
  const data = await client.call('/order/placeorder', {
    method: 'POST',
    body: {
      accountId: order.accountId,
      accountSpec: order.accountSpec,
      symbol: order.symbol,
      action: order.side === 'sell' || order.side === 'Sell' ? 'Sell' : 'Buy',
      orderQty: order.quantity,
      orderType: order.orderType || 'Market',
      isAutomated: true,
    },
  });
  return { ok: true, order: data };
}

export async function closeNinjaTraderPosition(client, position = {}) {
  if (!client || client.provider !== NINJATRADER_PROVIDER) {
    throw new Error('closeNinjaTraderPosition: client is not a NinjaTrader client');
  }
  if (client.mode === 'live' && !ninjaTraderLiveExecutionEnabled()) {
    return {
      ok: false,
      blocked: true,
      reason: 'NinjaTrader live execution is disabled (set NINJATRADER_LIVE_EXECUTION_ENABLED=true)',
    };
  }
  // Tradovate: liquidate the position for the contract on this account.
  const data = await client.call('/order/liquidateposition', {
    method: 'POST',
    body: { accountId: position.accountId, contractId: position.contractId, admin: false },
  });
  return { ok: true, result: data };
}
