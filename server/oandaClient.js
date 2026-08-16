import { isStrictUserPath, getRequestContext } from './requestContext.js';

/**
 * server/oandaClient.js
 *
 * Core OANDA v20 REST API HTTP helpers.
 *
 * 2026-05-27 multi-tenant refactor: this module now exposes a `createOandaClient({
 * apiKey, accountId, baseUrl, environment })` factory so every scan / trade /
 * reassessment call can run against the AUTHENTICATED USER's credentials,
 * resolved by the Next.js Route Handler from the user's broker_connections row.
 *
 * Backward compatibility:
 *   The legacy module-level helpers (`oandaGet`, `oandaPost`, `oandaPut`,
 *   `getAccountId`, `getOandaBaseUrl`, `oandaHeaders`) still work and now
 *   route through a default client that reads `process.env`. This default
 *   path is for DEV FALLBACK ONLY. It must never be reached on a per-user
 *   request — the new factory-based path takes precedence whenever a client
 *   is passed through.
 */

// ────────────────────────────────────────────────────────────────────────────
// Environment resolution helpers — preserved for the legacy/dev fallback path.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Normalize and resolve the active OANDA environment. Aliases:
 *   'paper' / 'demo' / 'sandbox' → 'practice'
 *   'real'                       → 'live'
 *   anything else                → 'practice'
 */
export function getEnvironment() {
  const raw = String(
    process.env.FOREX_TRADING_ENVIRONMENT ||
    process.env.OANDA_ENV ||
    'practice'
  ).toLowerCase().trim();
  if (raw === 'live' || raw === 'real') return 'live';
  return 'practice';
}

/**
 * Platform kill switch for live execution. Used as a back-compat fallback when
 * `PLATFORM_LIVE_TRADING_ENABLED` is unset.
 */
export function isLiveExecutionExplicitlyAllowed() {
  return String(process.env.FOREX_ALLOW_LIVE_EXECUTION || 'false').toLowerCase() === 'true';
}

function baseUrlFor(environment) {
  if (environment === 'live') {
    return process.env.OANDA_API_BASE_LIVE || 'https://api-fxtrade.oanda.com';
  }
  return process.env.OANDA_API_BASE_PRACTICE || 'https://api-fxpractice.oanda.com';
}

// ────────────────────────────────────────────────────────────────────────────
// Factory — produces a per-request OANDA client.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Build a request-scoped OANDA client. Every authenticated call from the
 * Next.js Route Handler passes credentials resolved from the user's
 * broker_connections row.
 *
 * @param {Object} ctx
 * @param {string} ctx.apiKey       — bearer token (decrypted, server-only)
 * @param {string} ctx.accountId    — OANDA account ID
 * @param {string} [ctx.baseUrl]    — full base URL (e.g. https://api-fxpractice.oanda.com)
 * @param {string} [ctx.environment]— 'practice' | 'live' (for logging only — baseUrl is authoritative)
 * @returns {{
 *   apiKey: string, accountId: string, baseUrl: string, environment: string,
 *   get:  (path: string) => Promise<any>,
 *   post: (path: string, body: any) => Promise<any>,
 *   put:  (path: string, body: any) => Promise<any>,
 *   isDefault: boolean,
 * }}
 */
export function createOandaClient(ctx) {
  if (!ctx || !ctx.apiKey) {
    throw new Error('createOandaClient: apiKey is required');
  }
  if (!ctx.accountId) {
    throw new Error('createOandaClient: accountId is required');
  }
  const environment = ctx.environment === 'live' || ctx.environment === 'real' ? 'live' : 'practice';
  const baseUrl = ctx.baseUrl || baseUrlFor(environment);

  const headers = () => ({
    Authorization: `Bearer ${ctx.apiKey}`,
    'Content-Type': 'application/json',
    'Accept-Datetime-Format': 'UNIX',
  });

  const fetchJson = async (method, path, body) => {
    const url = `${baseUrl}${path}`;
    // NB: we never log the apiKey. baseUrl and accountId are safe to log
    // (accountId on its own is not a credential — it needs the token to be useful).
    console.log(`[OANDA] ${method} ${url}${body ? ' (body redacted)' : ''}`);
    const init = { method, headers: headers() };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(url, init);
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* keep null */ }
    if (!res.ok) {
      const detail = data ? JSON.stringify(data) : text || '<empty>';
      throw new Error(`OANDA ${method} ${path} → [${res.status}]: ${detail}`);
    }
    return data;
  };

  return {
    apiKey: ctx.apiKey,
    accountId: ctx.accountId,
    userId: typeof ctx.userId === 'string' && ctx.userId.trim() ? ctx.userId.trim() : null,
    baseUrl,
    environment,
    isDefault: false,
    get: (path) => fetchJson('GET', path),
    post: (path, body) => fetchJson('POST', path, body),
    put: (path, body) => fetchJson('PUT', path, body),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Default (dev-fallback) client — sources credentials from process.env.
//
// EVERY authenticated user request MUST pass a per-request client through.
// The default client is only used when:
//   1. The legacy /api/oanda/* endpoints are called (back-compat)
//   2. Background tasks intentionally use platform-level creds (e.g. health
//      probes that don't depend on a user)
// ────────────────────────────────────────────────────────────────────────────

let _defaultClient = null;
let _defaultClientWarned = false;

function getDefaultClient() {
  // Defense-in-depth: refuse the default client inside an authenticated user
  // scope. This relies on the AsyncLocalStorage flag set by
  // `runUserScoped` in server/requestContext.js. If a future code path
  // inadvertently calls oandaGet/oandaPost without a per-request client while
  // serving a tester's scan, this throws instead of silently using my env
  // credentials.
  if (isStrictUserPath()) {
    const ctx = getRequestContext();
    const err = new Error(
      `getDefaultClient() called inside a user-scoped request ` +
        `(expected accountId "${ctx?.accountId ?? '<unknown>'}"). ` +
        `Refusing env-based fallback to prevent cross-tenant credential leak.`,
    );
    console.error('[STRICT_GUARD] getDefaultClient inside user scope:', err.stack);
    throw err;
  }
  // Return cached client only if env hasn't changed mid-process (unusual but
  // possible in tests). We re-read env each time we'd create a fresh one.
  if (_defaultClient) return _defaultClient;
  const apiKey = process.env.OANDA_API_KEY;
  const accountId = process.env.OANDA_ACCOUNT_ID;
  if (!apiKey) throw new Error('OANDA_API_KEY is not set — default client unavailable. Pass a per-request client instead.');
  if (!accountId) throw new Error('OANDA_ACCOUNT_ID is not set — default client unavailable. Pass a per-request client instead.');
  if (!_defaultClientWarned) {
    console.warn('[OANDA] Using DEFAULT env-based client. This is dev-fallback only — multi-user paths must pass a request-scoped client.');
    _defaultClientWarned = true;
  }
  _defaultClient = createOandaClient({
    apiKey,
    accountId,
    environment: getEnvironment(),
    baseUrl: baseUrlFor(getEnvironment()),
  });
  // Override the flag — the default client is distinguishable from a user one.
  _defaultClient.isDefault = true;
  return _defaultClient;
}

// ────────────────────────────────────────────────────────────────────────────
// Legacy module-level API. Preserved so existing callers continue to work.
// Each function delegates to the default client.
// ────────────────────────────────────────────────────────────────────────────

export function getOandaBaseUrl() { return baseUrlFor(getEnvironment()); }
export function oandaHeaders()    {
  return {
    Authorization: `Bearer ${process.env.OANDA_API_KEY || ''}`,
    'Content-Type': 'application/json',
    'Accept-Datetime-Format': 'UNIX',
  };
}
export function getAccountId() {
  const id = process.env.OANDA_ACCOUNT_ID || '';
  if (!id) throw new Error('OANDA_ACCOUNT_ID is not set in environment variables.');
  return id;
}

export async function oandaGet(path)        { return getDefaultClient().get(path); }
export async function oandaPost(path, body) { return getDefaultClient().post(path, body); }
export async function oandaPut(path, body)  { return getDefaultClient().put(path, body); }

/**
 * For tests / Next.js Route Handler reset hook — drops the cached default
 * client so the next call rebuilds from current process.env.
 */
export function __resetDefaultClient() {
  _defaultClient = null;
  _defaultClientWarned = false;
}
