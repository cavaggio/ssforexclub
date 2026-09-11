import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

function clean(v) { return String(v ?? '').trim(); }
let client;
function db(env = process.env) {
  if (client) return client;
  const url = clean(env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || env.VITE_SUPABASE_URL);
  const key = clean(env.SUPABASE_SERVICE_ROLE_KEY);
  if (!url || !key) throw new Error('Supabase service-role configuration is missing');
  client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}

export async function enqueueFtmoEaCommand({ accountLogin, terminalId, commandType, payload = {}, timeoutMs = 8000 }) {
  const idempotencyKey = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + Math.max(timeoutMs * 3, 30_000)).toISOString();
  const { data, error } = await db().from('mt5_ea_commands').insert({
    account_login: clean(accountLogin),
    terminal_id: clean(terminalId),
    command_type: clean(commandType),
    payload,
    idempotency_key: idempotencyKey,
    expires_at: expiresAt,
  }).select('id').single();
  if (error) throw new Error(`MT5 EA queue insert failed: ${error.message}`);
  return { id: String(data.id), idempotencyKey };
}

export async function waitForFtmoEaResult(commandId, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { data, error } = await db().from('mt5_ea_commands')
      .select('status,result,error')
      .eq('id', commandId)
      .maybeSingle();
    if (error) throw new Error(`MT5 EA queue read failed: ${error.message}`);
    if (!data) throw new Error('MT5 EA command disappeared from queue');
    if (data.status === 'completed') return data.result || { ok: true };
    if (data.status === 'failed' || data.status === 'expired') throw new Error(data.error || `MT5 EA command ${data.status}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`MT5 EA response timed out after ${timeoutMs}ms`);
}

export async function callFtmoEa(client, commandType, payload = {}) {
  const queued = await enqueueFtmoEaCommand({
    accountLogin: client.credentials.accountLogin,
    terminalId: client.credentials.terminalId,
    commandType,
    payload: { account: { login: client.credentials.accountLogin, server: client.credentials.server, terminalId: client.credentials.terminalId }, ...payload },
    timeoutMs: client.config.timeoutMs,
  });
  return waitForFtmoEaResult(queued.id, client.config.timeoutMs);
}
