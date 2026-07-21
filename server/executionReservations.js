import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const memory = new Map();
let client;

const ACTIVE_STATUSES = new Set(['reserved', 'open']);
const BLOCKING_STATUSES = new Set(['reserved', 'open', 'loss_locked']);

function db() {
  if (client !== undefined) return client;
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  client = url && key
    ? createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
    : null;
  return client;
}

function normalizePair(pair) {
  return String(pair || '').replace('/', '_').toUpperCase();
}

function normalizeDirection(direction) {
  const value = String(direction || '').toLowerCase();
  return value === 'long' || value === 'short' ? value : '';
}

function normalizeReleaseStatuses(statuses) {
  const values = Array.isArray(statuses) && statuses.length ? statuses : ['reserved', 'open'];
  return [...new Set(values.map((value) => String(value || '').toLowerCase()).filter((value) => ACTIVE_STATUSES.has(value)))];
}

function dateMs(value) {
  const ms = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

function memoryBlocks(row, nowMs = Date.now()) {
  if (!row || !BLOCKING_STATUSES.has(row.status)) return false;
  if (row.status === 'loss_locked') {
    return !row.lockedUntil || Number(row.lockedUntil) > nowMs;
  }
  return Number(row.expiresAt || 0) > nowMs;
}

function releaseMemoryWhere(predicate, status = 'released') {
  const releasedHashes = [];
  for (const [hash, row] of memory.entries()) {
    if (!predicate(row, hash)) continue;
    memory.set(hash, {
      ...row,
      status,
      expiresAt: 0,
      lockedUntil: null,
    });
    releasedHashes.push(hash);
  }
  return releasedHashes;
}

export function fingerprintHash(fingerprint) {
  return createHash('sha256').update(String(fingerprint)).digest('hex');
}

export async function reserveExecution({ fingerprint, accountId, pair, direction, expiresMinutes = 30 }) {
  const hash = fingerprintHash(fingerprint);
  const now = new Date();
  const nowMs = now.getTime();
  const expiresAt = new Date(nowMs + expiresMinutes * 60000).toISOString();
  const normalizedPair = normalizePair(pair);
  const normalizedDirection = normalizeDirection(direction);
  const local = memory.get(hash);
  const supabase = db();

  // When persistent state is available, it is authoritative over the process-local
  // cache. Transaction synchronization can release a broker-closed trade from
  // Supabase even though the Railway process still has an old `open` memory entry.
  if (supabase) {
    const { data: existing, error: readError } = await supabase
      .from('execution_reservations')
      .select('status,expires_at,locked_until,trade_id,account_id,pair,direction')
      .eq('fingerprint_hash', hash)
      .maybeSingle();

    if (readError) {
      return { allowed: false, reason: `reservation store error: ${readError.message}`, hash };
    }

    if (existing) {
      const locked =
        existing.status === 'loss_locked' &&
        (!existing.locked_until || dateMs(existing.locked_until) > nowMs);
      const active = ACTIVE_STATUSES.has(existing.status) && dateMs(existing.expires_at) > nowMs;

      if (locked || active) {
        memory.set(hash, {
          status: existing.status,
          expiresAt: dateMs(existing.expires_at),
          lockedUntil: dateMs(existing.locked_until) || null,
          tradeId: existing.trade_id ? String(existing.trade_id) : null,
          accountId: String(existing.account_id || accountId || ''),
          pair: normalizePair(existing.pair || normalizedPair),
          direction: normalizeDirection(existing.direction || normalizedDirection),
        });
        return { allowed: false, reason: `setup already ${existing.status}`, hash };
      }

      // The database says this reservation is terminal/released. Remove any stale
      // process-local copy so a fresh qualified setup can reserve immediately.
      if (memoryBlocks(local, nowMs)) memory.delete(hash);
    } else if (memoryBlocks(local, nowMs)) {
      // A missing persistent row also proves the local record is not authoritative.
      memory.delete(hash);
    }

    const { error } = await supabase.from('execution_reservations').upsert(
      {
        fingerprint_hash: hash,
        fingerprint,
        account_id: String(accountId || ''),
        pair: normalizedPair,
        direction: normalizedDirection,
        status: 'reserved',
        trade_id: null,
        locked_until: null,
        expires_at: expiresAt,
        updated_at: now.toISOString(),
      },
      { onConflict: 'fingerprint_hash' },
    );
    if (error) return { allowed: false, reason: `reservation store error: ${error.message}`, hash };
  } else if (memoryBlocks(local, nowMs)) {
    return { allowed: false, reason: `setup already ${local.status}`, hash };
  }

  memory.set(hash, {
    status: 'reserved',
    expiresAt: new Date(expiresAt).getTime(),
    lockedUntil: null,
    tradeId: null,
    accountId: String(accountId || ''),
    pair: normalizedPair,
    direction: normalizedDirection,
  });
  return { allowed: true, hash };
}

export async function markExecutionOpen({ hash, tradeId }) {
  const row = memory.get(hash) || {};
  memory.set(hash, { ...row, status: 'open', tradeId: tradeId == null ? null : String(tradeId) });
  const supabase = db();
  if (supabase) {
    await supabase
      .from('execution_reservations')
      .update({ status: 'open', trade_id: String(tradeId || ''), updated_at: new Date().toISOString() })
      .eq('fingerprint_hash', hash);
  }
}

export async function releaseExecution(hash, status = 'released') {
  const row = memory.get(hash) || {};
  memory.set(hash, { ...row, status, expiresAt: 0, lockedUntil: null });
  const supabase = db();
  if (supabase) {
    const now = new Date().toISOString();
    await supabase
      .from('execution_reservations')
      .update({ status, expires_at: now, locked_until: null, updated_at: now })
      .eq('fingerprint_hash', hash);
  }
}

export async function releaseExecutionByTradeId(tradeId, status = 'released') {
  const id = String(tradeId || '');
  if (!id) return { released: 0, hashes: [] };

  const hashes = releaseMemoryWhere((row) => String(row?.tradeId || '') === id, status);
  const supabase = db();
  if (supabase) {
    const now = new Date().toISOString();
    const { error } = await supabase
      .from('execution_reservations')
      .update({ status, expires_at: now, locked_until: null, updated_at: now })
      .eq('trade_id', id)
      .in('status', ['reserved', 'open']);
    if (error) throw new Error(`reservation release by trade id failed: ${error.message}`);
  }

  return { released: hashes.length, hashes };
}

export async function releaseExecutionsForPairDirection({
  accountId,
  pair,
  direction,
  status = 'released',
  statuses = ['reserved', 'open'],
}) {
  const account = String(accountId || '');
  const normalizedPair = normalizePair(pair);
  const normalizedDirection = normalizeDirection(direction);
  const releaseStatuses = normalizeReleaseStatuses(statuses);
  const releaseStatusSet = new Set(releaseStatuses);
  if (!normalizedPair || !normalizedDirection || releaseStatuses.length === 0) {
    return { released: 0, hashes: [] };
  }

  const hashes = releaseMemoryWhere((row) => {
    const sameAccount = !account || String(row?.accountId || '') === account;
    return (
      sameAccount &&
      normalizePair(row?.pair) === normalizedPair &&
      normalizeDirection(row?.direction) === normalizedDirection &&
      releaseStatusSet.has(row?.status)
    );
  }, status);

  const supabase = db();
  if (supabase) {
    const now = new Date().toISOString();
    let query = supabase
      .from('execution_reservations')
      .update({ status, expires_at: now, locked_until: null, updated_at: now })
      .eq('pair', normalizedPair)
      .eq('direction', normalizedDirection)
      .in('status', releaseStatuses);
    if (account) query = query.eq('account_id', account);
    const { error } = await query;
    if (error) throw new Error(`reservation release by pair/direction failed: ${error.message}`);
  }

  return { released: hashes.length, hashes };
}

export async function lockTradeAfterLoss(tradeId, hours = 24) {
  const id = String(tradeId || '');
  if (!id) return;
  const lockedUntil = new Date(Date.now() + hours * 3600000);

  for (const [hash, row] of memory.entries()) {
    if (String(row?.tradeId || '') !== id) continue;
    memory.set(hash, {
      ...row,
      status: 'loss_locked',
      expiresAt: lockedUntil.getTime(),
      lockedUntil: lockedUntil.getTime(),
    });
  }

  const supabase = db();
  if (!supabase) return;
  await supabase
    .from('execution_reservations')
    .update({
      status: 'loss_locked',
      locked_until: lockedUntil.toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('trade_id', id);
}

// Test-only reset. It is intentionally harmless in production and allows the
// reservation lifecycle to be covered without a database dependency.
export function __resetExecutionReservationsForTests() {
  memory.clear();
  client = undefined;
}
