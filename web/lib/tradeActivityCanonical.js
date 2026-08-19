const LIFECYCLE_EVENTS = new Set(['opened', 'closed', 'partial_closed', 'manual_close_executed']);
const TERMINAL_EVENTS = new Set(['closed', 'manual_close_executed']);

function ts(row) {
  const value = Date.parse(String(row?.created_at || ''));
  return Number.isFinite(value) ? value : 0;
}

function rawRecord(row) {
  return row?.raw_payload && typeof row.raw_payload === 'object' && !Array.isArray(row.raw_payload)
    ? row.raw_payload
    : {};
}

function deepValue(root, keys) {
  const queue = [root];
  const visited = new Set();
  let inspected = 0;
  while (queue.length && inspected < 250) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || visited.has(current)) continue;
    visited.add(current);
    inspected += 1;
    for (const key of keys) {
      const value = current[key];
      if (value !== undefined && value !== null && value !== '') return value;
    }
    for (const value of Object.values(current)) {
      if (value && typeof value === 'object') queue.push(value);
    }
  }
  return null;
}

function brokerEventId(row) {
  const raw = rawRecord(row);
  const rawId = deepValue(raw, ['transactionId', 'brokerOrderId', 'orderID', 'orderId']);
  if (rawId != null) return String(rawId);
  const mappedOrder = String(row?.broker_order_id || '').trim();
  const tradeId = String(row?.trade_id || '').trim();
  return mappedOrder && mappedOrder !== tradeId ? mappedOrder : '';
}

function richness(row) {
  let score = 0;
  if (row?.realized_pl != null && Number.isFinite(Number(row.realized_pl))) score += 8;
  if (row?.exit_price != null && Number.isFinite(Number(row.exit_price))) score += 4;
  if (brokerEventId(row)) score += 3;
  if (row?.instrument) score += 2;
  if (row?.side) score += 1;
  if (row?.reason) score += 1;
  if (rawRecord(row)?.source === 'oanda_transaction_sync') score += 6;
  return score;
}

function chooseBetter(a, b, preferEarlier = false) {
  if (!a) return b;
  const aScore = richness(a);
  const bScore = richness(b);
  if (aScore !== bScore) return bScore > aScore ? b : a;
  return preferEarlier ? (ts(b) < ts(a) ? b : a) : (ts(b) > ts(a) ? b : a);
}

function partialKey(row) {
  const eventId = brokerEventId(row);
  if (eventId) return `broker-event:${eventId}`;
  return [
    'partial',
    row?.trade_id || '',
    row?.units_closed ?? '',
    row?.exit_price ?? '',
    row?.realized_pl ?? '',
    row?.reason || '',
  ].join('|');
}

/**
 * Canonical trade activity is one lifecycle per broker trade:
 * - exactly one OPENED row,
 * - zero or more unique PARTIAL CLOSE rows,
 * - at most one terminal CLOSED row.
 *
 * Rows without a broker trade id are excluded because they cannot be safely
 * attributed to a position and were the source of repeated phantom closes in
 * the dashboard/activity feed.
 */
export function canonicalizeTradeActivityRows(rows = []) {
  const byTrade = new Map();

  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || !LIFECYCLE_EVENTS.has(row.event_type)) continue;
    const tradeId = String(row.trade_id || '').trim();
    if (!tradeId) continue;

    let bucket = byTrade.get(tradeId);
    if (!bucket) {
      bucket = { opened: null, terminal: null, partials: new Map() };
      byTrade.set(tradeId, bucket);
    }

    if (row.event_type === 'opened') {
      bucket.opened = chooseBetter(bucket.opened, row, true);
      continue;
    }

    if (TERMINAL_EVENTS.has(row.event_type)) {
      bucket.terminal = chooseBetter(bucket.terminal, row, false);
      continue;
    }

    if (row.event_type === 'partial_closed') {
      const key = partialKey(row);
      bucket.partials.set(key, chooseBetter(bucket.partials.get(key), row, false));
    }
  }

  const canonical = [];
  for (const bucket of byTrade.values()) {
    if (bucket.opened) canonical.push(bucket.opened);
    for (const row of bucket.partials.values()) canonical.push(row);
    if (bucket.terminal) canonical.push(bucket.terminal);
  }

  return canonical.sort((a, b) => ts(b) - ts(a));
}
