/** Server-only FTMO MT5 bridge connectivity probe for saved dashboard connections. */

import 'server-only';
import crypto from 'node:crypto';

export type FtmoBridgeProbe = {
  ok: boolean;
  definitiveFailure: boolean;
  status?: number;
  error?: string;
};

function value(creds: Record<string, unknown>, key: string): string {
  return String(creds[key] ?? '').trim();
}

function normalizeUrl(raw: string): string {
  const parsed = new URL(raw);
  const local = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) {
    throw new Error('FTMO MT5 bridge URL must use HTTPS');
  }
  return parsed.toString().replace(/\/$/, '');
}

export async function probeFtmoBridge(credentials: Record<string, unknown>): Promise<FtmoBridgeProbe> {
  const accountLogin = value(credentials, 'accountLogin');
  const server = value(credentials, 'server');
  const bridgeUrl = value(credentials, 'bridgeUrl');
  const bridgeApiKey = value(credentials, 'bridgeApiKey');
  const bridgeSecret = value(credentials, 'bridgeSecret');
  const terminalId = value(credentials, 'terminalId') || 'ftmo-primary';

  if (![accountLogin, server, bridgeUrl, bridgeApiKey, bridgeSecret].every(Boolean)) {
    return { ok: false, definitiveFailure: true, error: 'Missing FTMO MT5 bridge credentials' };
  }

  let baseUrl: string;
  try {
    baseUrl = normalizeUrl(bridgeUrl);
  } catch (error) {
    return { ok: false, definitiveFailure: true, error: error instanceof Error ? error.message : String(error) };
  }

  const body = JSON.stringify({
    account: { login: accountLogin, server, terminalId },
    operation: 'dashboard_validation',
  });
  const timestamp = String(Date.now());
  const nonce = crypto.randomUUID();
  const signature = crypto
    .createHmac('sha256', bridgeSecret)
    .update(`${timestamp}.${nonce}.${body}`)
    .digest('hex');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);

  try {
    const response = await fetch(`${baseUrl}/v1/health`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-signal-stack-key': bridgeApiKey,
        'x-signal-stack-timestamp': timestamp,
        'x-signal-stack-nonce': nonce,
        'x-signal-stack-signature': signature,
      },
      body,
      signal: controller.signal,
      cache: 'no-store',
    });

    if (response.ok) return { ok: true, definitiveFailure: false, status: response.status };
    const definitiveFailure = response.status >= 400 && response.status < 500;
    return {
      ok: false,
      definitiveFailure,
      status: response.status,
      error: `FTMO MT5 bridge returned HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      ok: false,
      definitiveFailure: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}
