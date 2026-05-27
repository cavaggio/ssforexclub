/**
 * server/oandaSignalStore.js
 * In-memory store for the latest backend scan results.
 * The scanner writes here after every scan; the frontend polls GET /api/oanda/signals.
 * Frontend NEVER generates signals independently.
 */

let _latestScan = null;      // ForexScanResult | null
let _lastUpdatedAt = null;   // ISO string
let _scanInProgress = false;

export function updateSignalStore(scanResult) {
  _latestScan = scanResult;
  _lastUpdatedAt = new Date().toISOString();
}

export function setScanInProgress(val) {
  _scanInProgress = Boolean(val);
}

export function getLatestSignals() {
  return {
    signals: _latestScan,
    lastUpdatedAt: _lastUpdatedAt,
    scanInProgress: _scanInProgress,
    ageSeconds: _lastUpdatedAt
      ? Math.round((Date.now() - new Date(_lastUpdatedAt).getTime()) / 1000)
      : null,
    hasSignals: _latestScan !== null,
  };
}

export function hasSignals() {
  return _latestScan !== null;
}
