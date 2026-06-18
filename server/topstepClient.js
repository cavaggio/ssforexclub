/**
 * server/topstepClient.js
 *
 * Topstep (TopstepX) prop-firm connector, built on the ProjectX Gateway API.
 * Entirely separate from OANDA and NinjaTrader; the provider guard
 * (server/providerRouting.js) prevents any cross-execution.
 *
 * Credential shape (multi-field, stored AES-256-GCM-encrypted as a JSON blob):
 *   { userName, apiKey }
 *
 * COMPLIANCE — Topstep's rules require automation to run on the trader's OWN
 * device and explicitly prohibit cloud/VPS/server-side execution. Because
 * app.ssforexclub.com is a cloud server, LIVE execution is hard-disabled here
 * unless an operator both confirms a rule change AND opts in:
 *   TOPSTEP_ENABLED                  — master switch (read-only data only)
 *   TOPSTEP_CLOUD_EXECUTION_ALLOWED  — MUST be true for any order to be sent
 *   TOPSTEP_LIVE_EXECUTION_ENABLED   — additionally required for funded/live
 * Read-only endpoints (validate / accounts / positions) work under TOPSTEP_ENABLED
 * so users can connect + monitor; orders are blocked with a clear message.
 */

import { PROVIDERS } from './providerRouting.js';

export const TOPSTEP_PROVIDER = PROVIDERS.TOPSTEP;

export const TOPSTEP_COMPLIANCE_MESSAGE =
  'Topstep execution is only enabled when your account, API permissions, and ' +
  'Topstep automation rules allow it. Topstep currently prohibits cloud/server-side ' +
  'automation, so live execution from app.ssforexclub.com is disabled.';

const REQUIRED_FIELDS = ['userName', 'apiKey'];

export function topstepEnabled() {
  return String(process.env.TOPSTEP_ENABLED || 'false').toLowerCase() === 'true';
}

export function topstepLiveExecutionEnabled() {
  return String(process.env.TOPSTEP_LIVE_EXECUTION_ENABLED || 'false').toLowerCase() === 'true';
}

/** Compliance flag: must be explicitly true before any order can leave the server. */
export function topstepCloudExecutionAllowed() {
  return String(process.env.TOPSTEP_CLOUD_EXECUTION_ALLOWED || 'false').toLowerCase() === 'true';
}

function gatewayBaseUrl() {
  return process.env.TOPSTEP_API_BASE_URL || 'https://api.topstepx.com';
}

/** Pure credential-shape validation — no network. */
export function validateTopstepCredentials(credentials) {
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
 * Resolve whether a Topstep order may be transmitted from this server.
 * Centralized so routes, tests, and the connector all agree. Returns
 * { allowed, reason } — allowed is true ONLY when every gate passes.
 */
export function evaluateTopstepExecution({ environment } = {}) {
  if (!topstepEnabled()) {
    return { allowed: false, reason: 'Topstep provider is disabled (set TOPSTEP_ENABLED=true)' };
  }
  if (!topstepCloudExecutionAllowed()) {
    return { allowed: false, reason: TOPSTEP_COMPLIANCE_MESSAGE };
  }
  const isFunded = environment === 'funded' || environment === 'live';
  if (isFunded && !topstepLiveExecutionEnabled()) {
    return { allowed: false, reason: 'Topstep funded/live execution is disabled (set TOPSTEP_LIVE_EXECUTION_ENABLED=true)' };
  }
  return { allowed: true, reason: 'All Topstep execution gates passed' };
}

export function buildTopstepClient({ credentials, environment = 'evaluation', fetchImpl, baseUrl } = {}) {
  const check = validateTopstepCredentials(credentials);
  if (!check.ok) throw new Error(`buildTopstepClient: ${check.error}`);
  if (!topstepEnabled()) {
    throw new Error('Topstep provider is disabled (set TOPSTEP_ENABLED=true)');
  }

  const mode = environment === 'funded' || environment === 'live' ? 'funded' : 'evaluation';
  const doFetch = fetchImpl || globalThis.fetch;
  const root = (baseUrl || gatewayBaseUrl()).replace(/\/+$/, '');

  let sessionToken = null;

  async function call(path, { method = 'POST', body, auth = true } = {}) {
    if (typeof doFetch !== 'function') {
      throw new Error('Topstep connector: no fetch implementation available');
    }
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (auth && sessionToken) headers.Authorization = `Bearer ${sessionToken}`;
    const res = await doFetch(`${root}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = typeof res.text === 'function' ? await res.text() : '';
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* keep null */ }
    if (!res.ok) {
      const detail = (data && (data.errorMessage || data.error)) || text || `HTTP ${res.status}`;
      const err = new Error(`Topstep gateway error: ${detail}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  return {
    provider: TOPSTEP_PROVIDER,
    mode,
    baseUrl: root,
    /** ProjectX API-key login → JWT (valid ~24h). */
    async authenticate() {
      const data = await call('/api/Auth/loginKey', {
        body: { userName: credentials.userName, apiKey: credentials.apiKey },
        auth: false,
      });
      sessionToken = (data && data.token) || null;
      const success = data ? data.success !== false && Boolean(sessionToken) : false;
      return { ok: success, mode };
    },
    call,
  };
}

export async function topstepConnectivityCheck({ credentials, environment, fetchImpl, baseUrl } = {}) {
  const shape = validateTopstepCredentials(credentials);
  if (!shape.ok) return { ok: false, status: 'invalid', error: shape.error, missing: shape.missing };
  try {
    const client = buildTopstepClient({ credentials, environment, fetchImpl, baseUrl });
    const auth = await client.authenticate();
    return auth.ok
      ? { ok: true, status: 'valid', mode: client.mode }
      : { ok: false, status: 'invalid', error: 'Authentication rejected by gateway' };
  } catch (err) {
    return { ok: false, status: 'invalid', error: err?.message || String(err) };
  }
}

export async function getTopstepAccounts(client) {
  if (!client || client.provider !== TOPSTEP_PROVIDER) {
    throw new Error('getTopstepAccounts: client is not a Topstep client');
  }
  const data = await client.call('/api/Account/search', { method: 'POST', body: { onlyActiveAccounts: true } });
  return (data && data.accounts) || [];
}

export async function getTopstepPositions(client, { accountId } = {}) {
  if (!client || client.provider !== TOPSTEP_PROVIDER) {
    throw new Error('getTopstepPositions: client is not a Topstep client');
  }
  const data = await client.call('/api/Position/searchOpen', { method: 'POST', body: { accountId } });
  return (data && data.positions) || [];
}

/**
 * Place an order. HARD-GATED by evaluateTopstepExecution — never transmits an
 * order while cloud execution is disallowed. Returns { ok:false, blocked:true }.
 */
export async function placeTopstepOrder(client, order = {}) {
  if (!client || client.provider !== TOPSTEP_PROVIDER) {
    throw new Error('placeTopstepOrder: client is not a Topstep client');
  }
  const gate = evaluateTopstepExecution({ environment: client.mode });
  if (!gate.allowed) {
    return { ok: false, blocked: true, reason: gate.reason };
  }
  const data = await client.call('/api/Order/place', {
    method: 'POST',
    body: {
      accountId: order.accountId,
      contractId: order.contractId || order.symbol,
      type: order.orderType || 2,        // 2 = market in ProjectX
      side: order.side,                   // 0 = buy, 1 = sell
      size: order.quantity,
      stopLossBracket: order.stopLoss ?? null,
      takeProfitBracket: order.takeProfit ?? null,
    },
  });
  return { ok: true, order: data };
}

export async function closeTopstepPosition(client, position = {}) {
  if (!client || client.provider !== TOPSTEP_PROVIDER) {
    throw new Error('closeTopstepPosition: client is not a Topstep client');
  }
  const gate = evaluateTopstepExecution({ environment: client.mode });
  if (!gate.allowed) {
    return { ok: false, blocked: true, reason: gate.reason };
  }
  const data = await client.call('/api/Position/closeContract', {
    method: 'POST',
    body: { accountId: position.accountId, contractId: position.contractId || position.symbol },
  });
  return { ok: true, result: data };
}
