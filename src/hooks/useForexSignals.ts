/**
 * src/hooks/useForexSignals.ts
 * React hook for polling forex signals from the backend.
 * Frontend NEVER generates signals — only renders what the backend provides.
 * Polls GET /api/oanda/signals every 20 s by default; runScan() triggers a full re-scan.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type { ForexScanResult } from '../types/forex.ts';

const API = '/api/oanda';
const DEFAULT_POLL_MS = 20_000;

export interface SignalStoreResponse {
  signals: ForexScanResult | null;
  lastUpdatedAt: string | null;
  scanInProgress: boolean;
  ageSeconds: number | null;
  hasSignals: boolean;
}

export interface UseForexSignalsReturn {
  scanResult: ForexScanResult | null;
  isLoading: boolean;
  isScanning: boolean;
  error: string | null;
  lastUpdatedAt: string | null;
  signalAgeSeconds: number | null;
  serverScanInProgress: boolean;
  runScan: () => Promise<void>;
  refresh: () => Promise<void>;
}

export function useForexSignals(pollIntervalMs = DEFAULT_POLL_MS): UseForexSignalsReturn {
  const [scanResult, setScanResult] = useState<ForexScanResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const [signalAgeSeconds, setSignalAgeSeconds] = useState<number | null>(null);
  const [serverScanInProgress, setServerScanInProgress] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const ageTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchLatestSignals = useCallback(async () => {
    try {
      const res = await fetch(`${API}/signals`);
      if (!res.ok) return;
      const data: SignalStoreResponse = await res.json();
      setServerScanInProgress(data.scanInProgress);
      if (data.signals) {
        setScanResult(data.signals);
        setLastUpdatedAt(data.lastUpdatedAt);
        setSignalAgeSeconds(data.ageSeconds);
        setError(null);
      }
    } catch {
      // Silent failure — keep showing stale data rather than disrupting UI
    }
  }, []);

  const runScan = useCallback(async () => {
    setIsScanning(true);
    setError(null);
    try {
      const res = await fetch(`${API}/scan`);
      const raw = await res.text();
      console.log('[OANDA SCAN RESPONSE]', {
        status: res.status,
        statusText: res.statusText,
        url: res.url,
        contentType: res.headers.get('content-type'),
        rawStart: raw.slice(0, 300),
      });
      if (!res.ok) {
        throw new Error(`Scan failed ${res.status}: ${raw.slice(0, 300)}`);
      }
      const result: ForexScanResult = JSON.parse(raw);
      setScanResult(result);
      setLastUpdatedAt(new Date().toISOString());
      setSignalAgeSeconds(0);
    } catch (err) {
      console.error('[OANDA SCAN FETCH FAILED]', err);
      setError(err instanceof Error ? err.message : 'Scan failed');
    } finally {
      setIsScanning(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    await fetchLatestSignals();
    setIsLoading(false);
  }, [fetchLatestSignals]);

  // Initial load + recurring poll
  useEffect(() => {
    fetchLatestSignals();
    pollTimer.current = setInterval(fetchLatestSignals, pollIntervalMs);
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, [fetchLatestSignals, pollIntervalMs]);

  // Local age counter — ticks every second when we have a lastUpdatedAt timestamp
  useEffect(() => {
    if (ageTimer.current) clearInterval(ageTimer.current);
    if (!lastUpdatedAt) return;
    ageTimer.current = setInterval(() => {
      setSignalAgeSeconds(
        Math.round((Date.now() - new Date(lastUpdatedAt).getTime()) / 1000)
      );
    }, 1000);
    return () => {
      if (ageTimer.current) clearInterval(ageTimer.current);
    };
  }, [lastUpdatedAt]);

  return {
    scanResult,
    isLoading,
    isScanning,
    error,
    lastUpdatedAt,
    signalAgeSeconds,
    serverScanInProgress,
    runScan,
    refresh,
  };
}
