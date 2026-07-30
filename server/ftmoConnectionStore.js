import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { validateFtmoCredentials } from './ftmoClient.js';

const ALGORITHM = 'aes-256-gcm';

function clean(value) {
  return String(value ?? '').trim();
}

function encryptionKey(env = process.env) {
  const raw = clean(env.FTMO_CREDENTIAL_ENCRYPTION_KEY || env.CREDENTIAL_ENCRYPTION_KEY);
  if (!raw) throw new Error('FTMO_CREDENTIAL_ENCRYPTION_KEY is not configured');
  return crypto.createHash('sha256').update(raw).digest();
}

function supabase(env = process.env) {
  const url = clean(env.SUPABASE_URL || env.VITE_SUPABASE_URL);
  const key = clean(env.SUPABASE_SERVICE_ROLE_KEY);
  if (!url || !key) throw new Error('Supabase service-role configuration is missing');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function encrypt(value, env = process.env) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, encryptionKey(env), iv);
  const encrypted = Buffer.concat([cipher.update(clean(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${encrypted.toString('base64')}`;
}

function decrypt(payload, env = process.env) {
  const [iv64, tag64, encrypted64] = clean(payload).split('.');
  if (!iv64 || !tag64 || !encrypted64) throw new Error('Stored FTMO credential is invalid');
  const decipher = crypto.createDecipheriv(ALGORITHM, encryptionKey(env), Buffer.from(iv64, 'base64'));
  decipher.setAuthTag(Buffer.from(tag64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(encrypted64, 'base64')), decipher.final()]).toString('utf8');
}

function normalize(input = {}) {
  return {
    accountLogin: clean(input.accountLogin || input.login),
    server: clean(input.server),
    bridgeUrl: clean(input.bridgeUrl),
    bridgeApiKey: clean(input.bridgeApiKey),
    bridgeSecret: clean(input.bridgeSecret),
    terminalId: clean(input.terminalId || 'ftmo-demo-primary'),
    environment: clean(input.environment || 'free_trial'),
    accountModel: clean(input.accountModel || 'demo'),
  };
}

function masked(row) {
  if (!row) return null;
  const login = clean(row.account_login);
  return {
    connected: row.status === 'connected',
    status: row.status,
    accountLoginMasked: login.length > 4 ? `${'*'.repeat(Math.min(login.length - 4, 8))}${login.slice(-4)}` : login,
    server: row.server,
    bridgeUrl: row.bridge_url,
    terminalId: row.terminal_id,
    environment: row.environment,
    accountModel: row.account_model,
    hasApiKey: Boolean(row.bridge_api_key_encrypted),
    hasBridgeSecret: Boolean(row.bridge_secret_encrypted),
    lastTestedAt: row.last_tested_at,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  };
}

export async function getFtmoConnection(userId, env = process.env) {
  const { data, error } = await supabase(env)
    .from('ftmo_client_connections')
    .select('*')
    .eq('user_id', String(userId))
    .maybeSingle();
  if (error) throw error;
  return masked(data);
}

export async function getFtmoCredentials(userId, env = process.env) {
  const { data, error } = await supabase(env)
    .from('ftmo_client_connections')
    .select('*')
    .eq('user_id', String(userId))
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    accountLogin: data.account_login,
    server: data.server,
    bridgeUrl: data.bridge_url,
    bridgeApiKey: decrypt(data.bridge_api_key_encrypted, env),
    bridgeSecret: decrypt(data.bridge_secret_encrypted, env),
    terminalId: data.terminal_id,
    environment: data.environment,
    accountModel: data.account_model,
  };
}

export async function saveFtmoConnection(userId, input, env = process.env) {
  const credentials = normalize(input);
  const validation = validateFtmoCredentials({ ...env, FTMO_ENABLED: 'true', FTMO_PROVIDER: 'mt5_bridge' }, credentials);
  if (!validation.ok) {
    const error = new Error(validation.error || 'Invalid FTMO connection details');
    error.missing = validation.missing || [];
    throw error;
  }

  const payload = {
    user_id: String(userId),
    account_login: credentials.accountLogin,
    server: credentials.server,
    bridge_url: credentials.bridgeUrl,
    bridge_api_key_encrypted: encrypt(credentials.bridgeApiKey, env),
    bridge_secret_encrypted: encrypt(credentials.bridgeSecret, env),
    terminal_id: credentials.terminalId,
    environment: credentials.environment,
    account_model: credentials.accountModel,
    status: 'saved',
    last_error: null,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase(env)
    .from('ftmo_client_connections')
    .upsert(payload, { onConflict: 'user_id' })
    .select('*')
    .single();
  if (error) throw error;
  return masked(data);
}

export async function testFtmoConnection(userId, env = process.env) {
  const credentials = await getFtmoCredentials(userId, env);
  if (!credentials) throw new Error('No FTMO connection has been saved');

  const body = JSON.stringify({
    account: {
      login: credentials.accountLogin,
      server: credentials.server,
      terminalId: credentials.terminalId,
    },
  });
  const timestamp = String(Date.now());
  const nonce = crypto.randomUUID();
  const signature = crypto
    .createHmac('sha256', credentials.bridgeSecret)
    .update(`${timestamp}.${nonce}.${body}`)
    .digest('hex');

  let ok = false;
  let errorMessage = null;
  try {
    const response = await fetch(`${credentials.bridgeUrl.replace(/\/$/, '')}/v1/diagnostics`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-signal-stack-key': credentials.bridgeApiKey,
        'x-signal-stack-timestamp': timestamp,
        'x-signal-stack-nonce': nonce,
        'x-signal-stack-signature': signature,
      },
      body,
      signal: AbortSignal.timeout(Number(env.FTMO_MT5_BRIDGE_TIMEOUT_MS || 8000)),
    });
    const payload = await response.json().catch(() => ({}));
    ok = response.ok && payload?.ok !== false;
    if (!ok) errorMessage = payload?.error || payload?.message || `Bridge returned HTTP ${response.status}`;
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
  }

  const { data, error } = await supabase(env)
    .from('ftmo_client_connections')
    .update({
      status: ok ? 'connected' : 'error',
      last_tested_at: new Date().toISOString(),
      last_error: ok ? null : errorMessage,
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', String(userId))
    .select('*')
    .single();
  if (error) throw error;
  return { ...masked(data), ok };
}

export async function deleteFtmoConnection(userId, env = process.env) {
  const { error } = await supabase(env)
    .from('ftmo_client_connections')
    .delete()
    .eq('user_id', String(userId));
  if (error) throw error;
  return { deleted: true };
}
