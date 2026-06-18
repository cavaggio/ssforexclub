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
  GATEWAY_URL_MISSING: 'NinjaTrader gateway URL is missing from server configuration.',
  SCANNER_ERROR: 'Scanner request failed.',
};

export function messageForCode(code, detail) {
  return DIAG_MESSAGES[code] || detail || 'Unexpected error.';
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

  // Connection badge by code.
  if (code === 'SCANNER_UNREACHABLE') view.connection = { tone: 'bad', label: 'Unable to reach scanner service' };
  else if (code === 'INTERNAL_AUTH_FAILED') view.connection = { tone: 'bad', label: 'Internal scanner authentication failed' };
  else if (code === 'BROKER_AUTH_FAILED') view.connection = { tone: 'bad', label: 'Credential validation failed' };
  else if (code === 'GATEWAY_URL_MISSING') view.connection = { tone: 'bad', label: 'Server configuration error' };
  else if (code === 'NO_ACCOUNTS') view.connection = { tone: 'warn', label: 'Connected — no accounts' };
  else if (code === 'OK') view.connection = { tone: 'good', label: 'Connected' };
  else view.connection = { tone: 'bad', label: 'Connection error' };

  view.message = messageForCode(code, diagnostics.message);

  // Mode badge: Live/Funded ONLY when validated, the account is live/funded,
  // and an account is actually selected. Otherwise default to Sim/Paper.
  const accountMode = diagnostics.accountMode || null;
  const isLiveAccount =
    validated &&
    Boolean(diagnostics.selectedAccount) &&
    (LIVE_MODES.has(connectionEnvironment) || LIVE_MODES.has(accountMode));
  view.mode = isLiveAccount
    ? { tone: 'warn', label: 'Live / Funded mode' }
    : { tone: 'muted', label: 'Simulated / Paper mode' };

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
