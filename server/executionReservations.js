import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const memory = new Map(); let client;
function db() {
  if (client !== undefined) return client;
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  client = url && key ? createClient(url, key, { auth: { persistSession:false, autoRefreshToken:false } }) : null;
  return client;
}
export function fingerprintHash(fingerprint) { return createHash('sha256').update(String(fingerprint)).digest('hex'); }
export async function reserveExecution({ fingerprint, accountId, pair, direction, expiresMinutes = 30 }) {
  const hash = fingerprintHash(fingerprint); const now = new Date(); const expiresAt = new Date(now.getTime() + expiresMinutes * 60000).toISOString();
  const local = memory.get(hash);
  if (local && local.expiresAt > now.getTime() && ['reserved','open','loss_locked'].includes(local.status)) return { allowed:false, reason:`setup already ${local.status}`, hash };
  const supabase = db();
  if (supabase) {
    const { data: existing } = await supabase.from('execution_reservations').select('status,expires_at,locked_until').eq('fingerprint_hash', hash).maybeSingle();
    if (existing) {
      const locked = existing.status === 'loss_locked' && (!existing.locked_until || new Date(existing.locked_until) > now);
      const active = ['reserved','open'].includes(existing.status) && new Date(existing.expires_at) > now;
      if (locked || active) return { allowed:false, reason:`setup already ${existing.status}`, hash };
    }
    const { error } = await supabase.from('execution_reservations').upsert({ fingerprint_hash:hash, fingerprint, account_id:String(accountId||''), pair, direction, status:'reserved', expires_at:expiresAt, updated_at:now.toISOString() }, { onConflict:'fingerprint_hash' });
    if (error) return { allowed:false, reason:`reservation store error: ${error.message}`, hash };
  }
  memory.set(hash, { status:'reserved', expiresAt:new Date(expiresAt).getTime() });
  return { allowed:true, hash };
}
export async function markExecutionOpen({ hash, tradeId }) {
  const row = memory.get(hash) || {}; memory.set(hash, { ...row, status:'open', tradeId });
  const supabase = db(); if (supabase) await supabase.from('execution_reservations').update({ status:'open', trade_id:String(tradeId||''), updated_at:new Date().toISOString() }).eq('fingerprint_hash', hash);
}
export async function releaseExecution(hash, status='released') {
  const row = memory.get(hash) || {}; memory.set(hash, { ...row, status, expiresAt:0 });
  const supabase = db(); if (supabase) await supabase.from('execution_reservations').update({ status, updated_at:new Date().toISOString() }).eq('fingerprint_hash', hash);
}
export async function lockTradeAfterLoss(tradeId, hours = 24) {
  const supabase = db(); if (!supabase || !tradeId) return;
  const lockedUntil = new Date(Date.now() + hours * 3600000).toISOString();
  await supabase.from('execution_reservations').update({ status:'loss_locked', locked_until:lockedUntil, updated_at:new Date().toISOString() }).eq('trade_id', String(tradeId));
}
