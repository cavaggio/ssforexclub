/**
 * src/lib/forexApi.ts
 * Front-end API client for all OANDA/Forex backend routes.
 */

import type {
  OandaDiagnostics,
  ForexScanResult,
  ForexSignal,
  ForexTradeResult,
  ForexTradeState,
  ActiveTradesResponse,
} from '../types/forex.ts';

const API_BASE = '/api/oanda';

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const raw = await res.text();
  const label = path.replace(/^\//, '').toUpperCase().replace(/\//g, '_');
  console.log(`[OANDA ${label} RESPONSE]`, {
    status: res.status,
    statusText: res.statusText,
    url: res.url,
    contentType: res.headers.get('content-type'),
    rawStart: raw.slice(0, 300),
  });
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Non-JSON response from ${url}: ${raw.slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new Error((data as { error?: string }).error || `Request failed: ${res.status}`);
  }
  return data as T;
}

export async function fetchDiagnostics(): Promise<OandaDiagnostics> {
  return apiFetch<OandaDiagnostics>('/diagnostics');
}

export async function fetchAccount(): Promise<{ account: Record<string, unknown> }> {
  return apiFetch('/account');
}

export async function fetchScan(): Promise<ForexScanResult> {
  return apiFetch<ForexScanResult>('/scan');
}

export async function fetchTradeState(): Promise<ForexTradeState> {
  return apiFetch<ForexTradeState>('/trade-state');
}

export async function submitTrade(signal: ForexSignal): Promise<ForexTradeResult> {
  return apiFetch<ForexTradeResult>('/trade', {
    method: 'POST',
    body: JSON.stringify({ signal }),
  });
}

export async function closePosition(instrument: string): Promise<{ success: boolean; reason?: string }> {
  return apiFetch('/close', {
    method: 'POST',
    body: JSON.stringify({ instrument }),
  });
}

export async function fetchActiveTrades(): Promise<ActiveTradesResponse> {
  return apiFetch<ActiveTradesResponse>('/active-trades/analysis');
}
