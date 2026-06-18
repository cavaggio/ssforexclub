/**
 * web/lib/brokerDisplay.js
 *
 * Pure, never-throwing display helpers for broker connections. Used by the
 * settings page (and anywhere a connection is rendered) so an unfamiliar broker,
 * a null validation_status, or a missing account_mode can never crash a render.
 * No secrets are ever read or returned here.
 */

const KNOWN_BROKERS = new Set(['oanda', 'alpaca', 'ninjatrader', 'topstep']);

const BROKER_LABELS = {
  oanda: 'OANDA',
  alpaca: 'Alpaca',
  ninjatrader: 'NinjaTrader / Tradovate',
  topstep: 'Topstep',
};

/** Lowercase + recognize; unknown values normalize to 'unknown' (never throws). */
export function normalizeBroker(value) {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return KNOWN_BROKERS.has(v) ? v : 'unknown';
}

export function brokerLabel(value) {
  return BROKER_LABELS[normalizeBroker(value)] || 'Unknown broker';
}

/** sim → paper; otherwise pass through known values; missing → 'unknown'. */
export function normalizeEnvironment(value) {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (v === 'sim') return 'paper';
  if (['practice', 'paper', 'live', 'evaluation', 'funded'].includes(v)) return v;
  return v || 'unknown';
}

/**
 * Canonical DB vocab is pending | validated | failed. Legacy values
 * (valid/invalid/unvalidated) are accepted too. Anything else → pending.
 */
export function normalizeValidationStatus(value) {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (v === 'validated' || v === 'valid') return 'validated';
  if (v === 'failed' || v === 'invalid' || v === 'validation failed') return 'validation failed';
  return 'validation pending';
}

/**
 * Build a safe, render-ready projection of a connection. Never throws and never
 * includes credentials. Accepts partial/loose objects (missing fields ok).
 */
export function formatBrokerConnection(connection) {
  const c = connection && typeof connection === 'object' ? connection : {};
  const isActive = c.isActive !== false;
  const validation = normalizeValidationStatus(c.validationStatus);
  let statusLabel;
  let statusTone;
  if (!isActive) {
    statusLabel = 'disabled';
    statusTone = 'muted';
  } else if (validation === 'validated') {
    statusLabel = 'validated';
    statusTone = 'good';
  } else if (validation === 'validation failed') {
    statusLabel = 'validation failed';
    statusTone = 'bad';
  } else {
    statusLabel = 'saved · validation pending';
    statusTone = 'muted';
  }
  return {
    brokerLabel: brokerLabel(c.broker),
    environment: normalizeEnvironment(c.environment),
    accountLabel: c.accountId ? String(c.accountId) : '—',
    statusLabel,
    statusTone,
  };
}
