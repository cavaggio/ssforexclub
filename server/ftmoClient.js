import crypto from 'crypto';
import { callFtmoEa } from './ftmoEaQueue.js';

const REQUIRED_EA_FIELDS = ['accountLogin', 'server', 'terminalId', 'terminalToken'];
const REQUIRED_LEGACY_FIELDS = ['accountLogin', 'server', 'bridgeUrl', 'bridgeApiKey', 'bridgeSecret'];

function truthy(value) { return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase()); }
function clean(value) { return String(value ?? '').trim(); }
function isLocalBridgeHost(hostname) { return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'; }

export function normalizeFtmoBridgeUrl(value) {
  const raw = clean(value);
  if (!raw) return '';
  const parsed = new URL(raw);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocalBridgeHost(parsed.hostname))) {
    throw new Error('FTMO MT5 bridge URL must use HTTPS');
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

export function ftmoConfig(env = process.env) {
  const timeout = Number(env.FTMO_MT5_BRIDGE_TIMEOUT_MS || env.FTMO_MT5_EA_TIMEOUT_MS || 8_000);
  return {
    enabled: truthy(env.FTMO_ENABLED),
    provider: clean(env.FTMO_PROVIDER || 'mt5_ea').toLowerCase(),
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
    terminalId: clean(stored.terminalId || env.FTMO_MT5_TERMINAL_ID || 'ftmo-primary'),
    terminalToken: clean(stored.terminalToken || env.FTMO_MT5_EA_TOKEN),
    bridgeUrl: clean(stored.bridgeUrl || stored.apiBaseUrl || env.FTMO_MT5_BRIDGE_URL),
    bridgeApiKey: clean(stored.bridgeApiKey || env.FTMO_MT5_BRIDGE_API_KEY),
    bridgeSecret: clean(stored.bridgeSecret || env.FTMO_MT5_BRIDGE_SECRET),
  };
}

export function validateFtmoCredentials(env = process.env, credentials = null) {
  const config = ftmoConfig(env);
  if (!config.enabled) return { ok: false, error: 'FTMO connector disabled', missing: [] };
  const resolved = resolveFtmoCredentials(credentials, env);
  const adapter = clean(credentials?.adapter || config.provider || (resolved.terminalToken ? 'mt5_ea' : 'mt5_bridge'));
  const required = adapter === 'mt5_ea' ? REQUIRED_EA_FIELDS : REQUIRED_LEGACY_FIELDS;
  const missing = required.filter((field) => !resolved[field]);
  if (missing.length) return { ok: false, error: `FTMO ${adapter} credentials missing`, missing };
  if (!/^\d+$/.test(resolved.accountLogin)) return { ok: false, error: 'FTMO MT5 login must contain digits only', missing: [] };
  if (adapter === 'mt5_ea' && resolved.terminalToken.length < 32) return { ok: false, error: 'MT5 EA terminal token is invalid', missing: [] };
  if (adapter === 'mt5_bridge') {
    if (resolved.bridgeSecret.length < 16) return { ok: false, error: 'FTMO MT5 bridge secret must be at least 16 characters', missing: [] };
    try { normalizeFtmoBridgeUrl(resolved.bridgeUrl); } catch (error) { return { ok: false, error: error.message, missing: [] }; }
  }
  return { ok: true, missing: [], adapter };
}

export function buildFtmoClient({ credentials = null, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const config = ftmoConfig(env);
  const validation = validateFtmoCredentials(env, credentials);
  if (!validation.ok) {
    const error = new Error(validation.error || 'FTMO credentials missing');
    error.missing = validation.missing || [];
    throw error;
  }
  const resolved = resolveFtmoCredentials(credentials, env);
  const adapter = validation.adapter || 'mt5_ea';
  return {
    provider: 'ftmo', adapter,
    accountId: resolved.accountLogin,
    environment: clean(credentials?.environment || env.FTMO_ENVIRONMENT || 'challenge'),
    config, fetchImpl,
    credentials: { ...resolved, bridgeUrl: resolved.bridgeUrl ? normalizeFtmoBridgeUrl(resolved.bridgeUrl) : '' },
  };
}

function assertFtmoClient(client) { if (!client || client.provider !== 'ftmo') throw new Error('Invalid FTMO client'); }

export function createFtmoBridgeSignature({ timestamp, nonce, body, secret }) {
  return crypto.createHmac('sha256', clean(secret)).update(`${timestamp}.${nonce}.${body}`).digest('hex');
}

function maskAccount(accountLogin) {
  const value = clean(accountLogin);
  if (value.length <= 6) return value ? `${value.slice(0, 1)}…${value.slice(-1)}` : null;
  return `${value.slice(0, 3)}…${value.slice(-3)}`;
}

async function callLegacyBridge(client, path, payload = {}) {
  const body = JSON.stringify({ account: { login: client.credentials.accountLogin, server: client.credentials.server, terminalId: client.credentials.terminalId }, ...payload });
  const timestamp = String(Date.now()); const nonce = crypto.randomUUID();
  const signature = createFtmoBridgeSignature({ timestamp, nonce, body, secret: client.credentials.bridgeSecret });
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), client.config.timeoutMs);
  try {
    const response = await client.fetchImpl(`${client.credentials.bridgeUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signal-stack-key': client.credentials.bridgeApiKey, 'x-signal-stack-timestamp': timestamp, 'x-signal-stack-nonce': nonce, 'x-signal-stack-signature': signature }, body, signal: controller.signal });
    const text = await response.text(); let data = {};
    if (text) { try { data = JSON.parse(text); } catch { data = { message: text.slice(0, 500) }; } }
    if (!response.ok) throw new Error(data?.error || data?.message || `FTMO MT5 bridge returned HTTP ${response.status}`);
    return data;
  } finally { clearTimeout(timeout); }
}

async function callConnector(client, operation, payload = {}) {
  assertFtmoClient(client);
  if (client.adapter === 'mt5_ea') return callFtmoEa(client, operation, payload);
  const paths = { health: '/v1/health', account_summary: '/v1/account/summary', positions_list: '/v1/positions/list', order_place: '/v1/orders/place', position_close: '/v1/positions/close' };
  return callLegacyBridge(client, paths[operation], payload);
}

export function getFtmoDiagnostics(client) {
  assertFtmoClient(client);
  return { provider: 'ftmo', adapter: client.adapter, accountId: maskAccount(client.accountId), server: client.credentials.server, terminalId: client.credentials.terminalId, liveExecutionEnabled: client.config.liveExecutionEnabled, autoTradeEnabled: client.config.autoTradeEnabled, useV3: client.config.useV3, useICT: client.config.useICT };
}

export async function ftmoConnectivityCheck(client) { return callConnector(client, 'health', { operation: 'connectivity_check' }); }
export async function getFtmoAccountSummary(client) { return callConnector(client, 'account_summary'); }
export async function getFtmoPositions(client) { return callConnector(client, 'positions_list'); }

function requirePositiveNumber(value, label) { const number = Number(value); if (!Number.isFinite(number) || number <= 0) throw new Error(`${label} must be greater than 0`); return number; }

export async function placeFtmoOrder(client, order = {}) {
  assertFtmoClient(client);
  if (!client.config.liveExecutionEnabled) return { ok: false, blocked: true, provider: 'ftmo', adapter: client.adapter, reason: 'FTMO live execution disabled' };
  const symbol = clean(order.symbol); const side = clean(order.side).toLowerCase();
  if (!symbol) throw new Error('FTMO order symbol is required');
  if (!['buy', 'sell'].includes(side)) throw new Error('FTMO order side must be buy or sell');
  const normalizedOrder = { ...order, symbol, side, volume: requirePositiveNumber(order.volume, 'FTMO order volume') };
  return callConnector(client, 'order_place', { order: normalizedOrder });
}

export async function closeFtmoPosition(client, position = {}) {
  assertFtmoClient(client);
  if (!client.config.liveExecutionEnabled) return { ok: false, blocked: true, provider: 'ftmo', adapter: client.adapter, reason: 'FTMO live execution disabled' };
  const positionId = clean(position.positionId || position.ticket);
  if (!positionId) throw new Error('FTMO positionId is required');
  const normalizedPosition = { ...position, positionId };
  if (position.volume != null && clean(position.volume) !== '') normalizedPosition.volume = requirePositiveNumber(position.volume, 'FTMO close volume');
  return callConnector(client, 'position_close', { position: normalizedPosition });
}
