/**
 * web/lib/futuresStatus.js
 *
 * Pure, isomorphic (no server-only, no Node APIs) logic for the futures
 * connection panel. It is the SINGLE source of truth for:
 *   - mapping a scanner transport failure to a stable error code
 *   - deriving every UI state (connection badge, mode badge, execution badge,
 *     execute-button visibility/enabled, and the user-facing message)
 *
 * Keeping it pure means both the Next.js proxy (server) and the client panel
 * import the same logic, and it is exhaustively unit-tested with node --test.
 *
 * Safety rule encoded here: "Execution enabled" requires EVERY gate to pass.
 * A failed/missing validation can never render as executable.
 */

export const DIAG_MESSAGES = {
  OK: 'Connected.',
  NO_ACCOUNTS: 'NinjaTrader / Tradovate returned no accounts.',
  NO_CREDENTIALS: 'No NinjaTrader / Tradovate credentials saved.',
  CONNECTOR_DISABLED: 'The futures connector is disabled by the platform.',
  SCANNER_UNREACHABLE: 'Unable to reach scanner service.',
  INTERNAL_AUTH_FAILED: 'Internal scanner authentication failed.',
  BROKER_AUTH_FAILED:
    'NinjaTrader / Tradovate authentication failed. Check username, password, app ID, app version, CID, and secret.',
  ENVIRONMENT_MISMATCH: 'Saved connection does not match the selected mode.',
  GATEWAY_URL_MISSING: 'NinjaTrader gateway URL is missing from server configuration.',
  SCANNER_ERROR: 'Scanner request failed.',
};

const ENV_LABEL = { paper: 'Simulated / Paper', sim: 'Simulated / Paper', live: 'Live', funded: 'Funded', evaluation: 'Evaluation' };

export function messageForCode(code, detail) {
  return DIAG_MESSAGES[code] || detail || 'Unexpected error.';
}

/** Friendly, specific message for an environment mismatch (no generic auth error). */
export function environmentMismatchMessage(savedEnv, requestedEnv) {
  const saved = ENV_LABEL[savedEnv] || savedEnv || 'unknown';
  const want = ENV_LABEL[requestedEnv] || requestedEnv || 'unknown';
  return `Saved NinjaTrader / Tradovate connection is ${saved}, but the current Futures mode is ${want}. ` +
    `Switch to ${saved} mode, or save ${want} credentials.`;
}

const LIVE_ENVS = new Set(['live', 'funded']);

/**
 * Decide a connection's validation outcome from a probe result. Returns
 * 'valid' | 'invalid' | 'skip'. 'skip' means we could NOT actually reach the
 * broker (scanner down / internal-auth / connector disabled) — so we must NOT
 * mark a known-good account as failed; leave its status untouched.
 *
 *   ok             transport success (the internal endpoint returned 2xx)
 *   transportCode  from mapScannerTransportError when !ok
 *   code           connector diagnostic code (futures), if present
 *   validationStatus connector validationStatus (futures), if present
 */
export function classifyValidationResult({ ok, transportCode, code, validationStatus } = {}) {
  if (transportCode === 'SCANNER_UNREACHABLE' || transportCode === 'INTERNAL_AUTH_FAILED') return 'skip';
  if (code === 'CONNECTOR_DISABLED' || code === 'GATEWAY_URL_MISSING') return 'skip';
  if (validationStatus === 'valid' || code === 'OK' || code === 'NO_ACCOUNTS') return 'validated';
  if (validationStatus === 'invalid' || code === 'BROKER_AUTH_FAILED') return 'failed';
  if (ok === true) return 'validated';   // OANDA risk-status 200 with no diagnostic code
  return 'failed';                       // broker responded with a rejection
}

/**
 * Pick the saved connection that matches the requested environment. Treats
 * paper/sim as equivalent and live/funded as equivalent (provider-specific
 * synonyms). Returns { match } or { match:null, savedEnvironments } so the
 * caller can short-circuit WITHOUT calling broker auth on a mismatch.
 */
export function pickConnectionForEnvironment(connections, requestedEnv) {
  const list = Array.isArray(connections) ? connections : [];
  const wantLive = LIVE_ENVS.has(requestedEnv);
  const match = list.find((c) => LIVE_ENVS.has(c.environment) === wantLive) || null;
  return { match, savedEnvironments: list.map((c) => c.environment) };
}

/**
 * Map a failed callInternalEndpoint result ({ status, error }) to a stable code.
 * Never returns a raw "fetch failed".
 */
export function mapScannerTransportError(result) {
  const status = result && typeof result.status === 'number' ? result.status : 0;
  const e = String((result && result.error) || '');
  if (/SCANNER_INTERNAL_SECRET not configured/i.test(e)) return { code: 'INTERNAL_AUTH_FAILED' };
  if (status === 401 || /invalid or missing x-internal-auth|internal scanner auth/i.test(e)) {
    return { code: 'INTERNAL_AUTH_FAILED' };
  }
  if (status === 502 || /unreachable|fetch failed|econnrefused|enotfound|network/i.test(e)) {
    return { code: 'SCANNER_UNREACHABLE' };
  }
  return { code: 'SCANNER_ERROR', detail: e };
}

const VALID_CODES = new Set(['OK', 'NO_ACCOUNTS']);
const LIVE_MODES = new Set(['live', 'funded']);

/**
 * Derive the full panel view from server-known gates + the diagnostics payload.
 *
 * inputs:
 *   enabled               provider master flag (server env)
 *   liveFlag              live-execution permitted by flags (provider-specific;
 *                         for Topstep this already folds in cloud-execution-allowed)
 *   liveAck               user-level live-trading acknowledgement (or null if n/a)
 *   hasConnection         a saved connection exists for this provider
 *   connectionEnvironment stored environment of the connection ('paper'|'live'|...)
 *   complianceMessage     optional message shown when execution is force-disabled
 *   diagnostics           the /diagnostics response, or null while loading/none
 *
 * returns a plain object the panel renders directly.
 */
export function deriveFuturesView({
  enabled,
  liveFlag,
  liveAck,
  hasConnection,
  connectionEnvironment,
  complianceMessage,
  diagnostics,
} = {}) {
  const view = {
    connection: { tone: 'muted', label: 'Not connected' },
    mode: { tone: 'muted', label: 'Simulated / Paper mode' },
    execution: { tone: 'bad', label: 'Execution disabled' },
    executeVisible: false,
    executeEnabled: false,
    message: '',
    code: null,
  };

  // The mode badge reflects the SAVED connection's environment (the user's
  // choice), independent of validation — so a saved live connection never shows
  // "Simulated / Paper". Execution gating below is separate.
  const savedIsLive = LIVE_ENVS.has(connectionEnvironment);
  if (hasConnection) {
    view.mode = savedIsLive
      ? { tone: 'warn', label: 'Live / Funded mode' }
      : { tone: 'muted', label: 'Simulated / Paper mode' };
  }

  if (!hasConnection) {
    view.connection = { tone: 'muted', label: 'No credentials saved' };
    view.code = 'NO_CREDENTIALS';
    view.message = 'Enter NinjaTrader / Tradovate credentials to validate the connection.';
    return view;
  }

  if (!enabled) {
    view.connection = { tone: 'warn', label: 'Connector disabled' };
    view.code = 'CONNECTOR_DISABLED';
    view.message = messageForCode('CONNECTOR_DISABLED');
    return view;
  }

  // Connection exists + provider enabled → diagnostics drive the rest.
  if (!diagnostics) {
    view.connection = { tone: 'muted', label: 'Checking…' };
    return view;
  }

  const code = diagnostics.code || (diagnostics.ok ? 'OK' : 'SCANNER_ERROR');
  view.code = code;
  const validated = VALID_CODES.has(code) && diagnostics.validationStatus === 'valid';

  // Connection badge by code. ENVIRONMENT_MISMATCH is its own state — a clear,
  // specific message, never a generic "credential validation failed".
  if (code === 'ENVIRONMENT_MISMATCH') {
    view.connection = { tone: 'warn', label: 'Environment mismatch' };
    view.message = diagnostics.message || 'Saved connection does not match the selected mode.';
    return view; // no validation attempted — execution stays disabled, button hidden
  }
  if (code === 'SCANNER_UNREACHABLE') view.connection = { tone: 'bad', label: 'Unable to reach scanner service' };
  else if (code === 'INTERNAL_AUTH_FAILED') view.connection = { tone: 'bad', label: 'Internal scanner authentication failed' };
  else if (code === 'BROKER_AUTH_FAILED') view.connection = { tone: 'bad', label: 'Credential validation failed' };
  else if (code === 'GATEWAY_URL_MISSING') view.connection = { tone: 'bad', label: 'Server configuration error' };
  else if (code === 'NO_ACCOUNTS') view.connection = { tone: 'warn', label: 'Connected — no accounts' };
  else if (code === 'OK') view.connection = { tone: 'good', label: 'Connected' };
  else view.connection = { tone: 'bad', label: 'Connection error' };

  view.message = messageForCode(code, diagnostics.message);

  // The mode badge was already set from the saved connection above. For execution
  // gating we additionally require the validated account itself to be live/funded.
  const accountMode = diagnostics.accountMode || null;
  const isLiveAccount =
    validated &&
    Boolean(diagnostics.selectedAccount) &&
    (LIVE_MODES.has(connectionEnvironment) || LIVE_MODES.has(accountMode));

  // Execution enabled requires EVERY gate.
  const ackOk = liveAck === null || liveAck === true; // null = not applicable to this provider
  view.executeEnabled = Boolean(
    liveFlag === true &&
    validated &&
    Boolean(diagnostics.selectedAccount) &&
    isLiveAccount &&
    ackOk &&
    diagnostics.executionAllowed === true,
  );
  view.execution = view.executeEnabled
    ? { tone: 'good', label: 'Execution enabled' }
    : { tone: 'bad', label: 'Execution disabled' };

  // Show the button only once credentials validate; disable until every gate passes.
  view.executeVisible = validated;

  if (!view.executeEnabled && complianceMessage && (code === 'OK' || code === 'NO_ACCOUNTS')) {
    view.message = complianceMessage;
  }

  return view;
}
