/**
 * web/lib/connectionValidation.ts
 *
 * Server-only: probe a saved broker connection's credentials and persist the
 * outcome to broker_connections.validation_status. Credentials are decrypted
 * only in memory for the probe and never returned or logged.
 */

import 'server-only';
import {
  getDecryptedBrokerCredentials,
  resolveBrokerBaseUrl,
  setConnectionValidationStatus,
  type BrokerConnection,
} from './brokerConnections';
import { resolveFuturesCredentials } from './futuresProvider';
import { probeFtmoBridge } from './ftmoBridge';
import { callInternalEndpoint } from './scannerProxy';
import { mapScannerTransportError, classifyValidationResult } from './futuresStatus';

type ProbeResult = 'validated' | 'failed' | 'skip';

export type ConnectionValidationOutcome = {
  connectionId: string;
  broker: string;
  result: ProbeResult;
  updateFailed: boolean;
};

async function probeOanda(userId: string, conn: BrokerConnection): Promise<ProbeResult> {
  const creds = await getDecryptedBrokerCredentials(userId, conn.id);
  if (!creds) return 'failed';
  let baseUrl: string;
  try {
    baseUrl = resolveBrokerBaseUrl(conn.broker, conn.environment);
  } catch {
    return 'failed';
  }
  const res = await callInternalEndpoint('/api/internal/oanda/risk-status', {
    apiKey: creds.token,
    accountId: creds.accountId,
    baseUrl,
    environment: conn.environment,
  });
  if (res.ok) return classifyValidationResult({ ok: true });
  const { code } = mapScannerTransportError(res);
  return classifyValidationResult({ ok: false, transportCode: code });
}

async function probeFutures(userId: string, conn: BrokerConnection): Promise<ProbeResult> {
  const resolved = await resolveFuturesCredentials(userId, conn.id);
  if (!resolved) return 'failed';
  const res = await callInternalEndpoint(`/api/internal/${conn.broker}/diagnostics`, {
    provider: conn.broker,
    credentials: resolved.credentials,
    environment: resolved.environment,
  });
  if (!res.ok) {
    const { code } = mapScannerTransportError(res);
    return classifyValidationResult({ ok: false, transportCode: code });
  }
  const data = (res.data && typeof res.data === 'object' ? res.data : {}) as Record<string, unknown>;
  return classifyValidationResult({
    ok: true,
    code: typeof data.code === 'string' ? data.code : undefined,
    validationStatus: typeof data.validationStatus === 'string' ? data.validationStatus : undefined,
  });
}

async function probeFtmo(userId: string, conn: BrokerConnection): Promise<ProbeResult> {
  const resolved = await resolveFuturesCredentials(userId, conn.id);
  if (!resolved || resolved.provider !== 'ftmo') return 'failed';
  const result = await probeFtmoBridge(resolved.credentials);
  if (result.ok) return 'validated';
  return result.definitiveFailure ? 'failed' : 'skip';
}

export async function validateConnection(userId: string, conn: BrokerConnection): Promise<ConnectionValidationOutcome> {
  let result: ProbeResult;
  try {
    if (conn.broker === 'oanda' || conn.broker === 'alpaca') {
      result = await probeOanda(userId, conn);
    } else if (conn.broker === 'ftmo') {
      result = await probeFtmo(userId, conn);
    } else if (conn.broker === 'ninjatrader' || conn.broker === 'topstep') {
      result = await probeFutures(userId, conn);
    } else {
      result = 'failed';
    }
  } catch {
    result = 'skip';
  }

  let updateFailed = false;
  if (result === 'validated' || result === 'failed') {
    const persisted = await setConnectionValidationStatus(userId, conn.id, result);
    updateFailed = !persisted.ok;
    if (updateFailed) {
      console.warn(`[VALIDATE] persist FAILED broker=${conn.broker} connection=${conn.id} reason=${'code' in persisted ? persisted.code : '?'}`);
    }
  }
  console.log(`[VALIDATE] broker=${conn.broker} env=${conn.environment} connection=${conn.id} result=${result} persisted=${!updateFailed}`);
  return { connectionId: conn.id, broker: conn.broker, result, updateFailed };
}

export async function validateAllConnections(userId: string, connections: BrokerConnection[]): Promise<ConnectionValidationOutcome[]> {
  const active = connections.filter((c) => c.isActive);
  const out: ConnectionValidationOutcome[] = [];
  for (const c of active) {
    out.push(await validateConnection(userId, c));
  }
  return out;
}
