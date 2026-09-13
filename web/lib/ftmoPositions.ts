import 'server-only';

import crypto from 'node:crypto';
import { getServerSupabase } from './db';

/**
 * FTMO / MT5 position sizing contract.
 *
 * MetaTrader executes positions in VOLUME (lots), not OANDA-style units.
 * `volume` is therefore the canonical broker size everywhere on the FTMO path.
 * `notionalUnits` is derived strictly for reporting / compatibility using the
 * broker-reported SYMBOL_TRADE_CONTRACT_SIZE; it is never sent back to MT5 as
 * an execution size.
 */
export type FtmoPosition = {
  ticket: string;
  symbol: string;
  side: 'long' | 'short';
  volume: number;
  volumeMin: number | null;
  volumeMax: number | null;
  volumeStep: number | null;
  contractSize: number | null;
  notionalUnits: number | null;
  entryPrice: number;
  currentPrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
  profit: number;
  openTime: string | null;
  openTimeEpochMs: number | null;
  magic: string | null;
  comment: string | null;
  managedBySignalStack: boolean;
};

export type FtmoPositionsSnapshot = {
  accountLogin: string;
  terminalId: string;
  positionCount: number;
  positions: FtmoPosition[];
  detailAvailable: boolean;
  sizeUnit: 'lots';
  raw: Record<string, unknown>;
};

function finite(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nullableFinite(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveOrNull(value: unknown): number | null {
  const parsed = nullableFinite(value);
  return parsed != null && parsed > 0 ? parsed : null;
}

function normalizeSymbol(symbol: unknown): string {
  return String(symbol || '').trim().toUpperCase();
}

function isoFromPositionTime(row: Record<string, unknown>): { openTime: string | null; openTimeEpochMs: number | null } {
  const epochMs = nullableFinite(row.openTimeEpochMs ?? row.timeMsc ?? row.positionTimeMsc);
  if (epochMs != null && epochMs > 0) {
    const date = new Date(epochMs);
    if (Number.isFinite(date.getTime())) {
      return { openTime: date.toISOString(), openTimeEpochMs: epochMs };
    }
  }

  if (row.openTime) {
    const raw = String(row.openTime);
    // MQL5 commonly emits `YYYY.MM.DD HH:MM:SS`; normalize that to ISO.
    const mt5 = raw.match(/^(\d{4})\.(\d{2})\.(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
    const candidate = mt5
      ? `${mt5[1]}-${mt5[2]}-${mt5[3]}T${mt5[4]}:${mt5[5]}:${mt5[6]}Z`
      : raw;
    const parsed = new Date(candidate);
    if (Number.isFinite(parsed.getTime())) {
      return { openTime: parsed.toISOString(), openTimeEpochMs: parsed.getTime() };
    }
    return { openTime: raw, openTimeEpochMs: null };
  }

  return { openTime: null, openTimeEpochMs: null };
}

function normalizePosition(value: unknown): FtmoPosition | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const ticket = String(row.ticket ?? row.positionId ?? row.id ?? '').trim();
  const symbol = normalizeSymbol(row.symbol);
  if (!ticket || !symbol) return null;

  const rawSide = String(row.side ?? row.direction ?? row.type ?? '').toLowerCase();
  const side: 'long' | 'short' =
    rawSide === 'sell' || rawSide === 'short' || rawSide === '1'
      ? 'short'
      : 'long';

  // MT5-native size. Do not reinterpret an OANDA-style `units` value as lots.
  // The `units` fallback is retained only for legacy pre-v1.22 snapshots where
  // the old EA accidentally returned volume under the units key.
  const volume = Math.abs(finite(row.volume ?? row.lots ?? row.units, 0));
  const contractSize = positiveOrNull(row.contractSize ?? row.tradeContractSize);
  const reportedNotionalUnits = positiveOrNull(row.notionalUnits);
  const notionalUnits = reportedNotionalUnits ?? (
    contractSize != null && volume > 0
      ? volume * contractSize
      : null
  );
  const opened = isoFromPositionTime(row);

  return {
    ticket,
    symbol,
    side,
    volume,
    volumeMin: positiveOrNull(row.volumeMin),
    volumeMax: positiveOrNull(row.volumeMax),
    volumeStep: positiveOrNull(row.volumeStep),
    contractSize,
    notionalUnits,
    entryPrice: finite(row.entryPrice ?? row.priceOpen ?? row.openPrice, 0),
    currentPrice: finite(row.currentPrice ?? row.priceCurrent ?? row.marketPrice, 0),
    stopLoss: nullableFinite(row.stopLoss ?? row.sl),
    takeProfit: nullableFinite(row.takeProfit ?? row.tp),
    profit: finite(row.profit ?? row.unrealizedPL, 0),
    openTime: opened.openTime,
    openTimeEpochMs: opened.openTimeEpochMs,
    magic: row.magic == null ? null : String(row.magic),
    comment: row.comment == null ? null : String(row.comment),
    managedBySignalStack: row.managedBySignalStack === true || String(row.managedBySignalStack).toLowerCase() === 'true',
  };
}

async function latestConnectedTerminal(userId: string) {
  const supabase = getServerSupabase();
  const { data, error } = await supabase
    .from('mt5_ea_terminals')
    .select('account_login,terminal_id,status,last_heartbeat_at,risk_policy_version')
    .eq('user_id', userId)
    .eq('status', 'connected')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`FTMO terminal lookup failed: ${error.message}`);
  if (!data?.account_login || !data?.terminal_id || !data?.last_heartbeat_at) {
    throw new Error('FTMO MT5 terminal is not connected');
  }

  const heartbeatMs = new Date(String(data.last_heartbeat_at)).getTime();
  if (!Number.isFinite(heartbeatMs) || Date.now() - heartbeatMs > 120_000) {
    throw new Error('FTMO MT5 heartbeat is stale');
  }

  return {
    accountLogin: String(data.account_login),
    terminalId: String(data.terminal_id),
    riskPolicyVersion: data.risk_policy_version ? String(data.risk_policy_version) : null,
  };
}

async function enqueueReadCommand(accountLogin: string, terminalId: string) {
  const supabase = getServerSupabase();
  const idempotencyKey = `ftmo-positions:${accountLogin}:${terminalId}:${crypto.randomUUID()}`;
  const { data, error } = await supabase
    .from('mt5_ea_commands')
    .insert({
      account_login: accountLogin,
      terminal_id: terminalId,
      command_type: 'positions_list',
      payload: { detail: true, sizeUnit: 'lots', source: 'signal-stack-dashboard' },
      idempotency_key: idempotencyKey,
      status: 'pending',
      expires_at: new Date(Date.now() + 30_000).toISOString(),
    })
    .select('id')
    .single();

  if (error || !data?.id) {
    throw new Error(`FTMO positions command failed to queue: ${error?.message ?? 'no command id'}`);
  }

  return String(data.id);
}

async function waitForResult(commandId: string, timeoutMs = 8_000): Promise<Record<string, unknown>> {
  const supabase = getServerSupabase();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const { data, error } = await supabase
      .from('mt5_ea_commands')
      .select('status,result,error')
      .eq('id', commandId)
      .maybeSingle();

    if (error) throw new Error(`FTMO positions command read failed: ${error.message}`);
    if (!data) throw new Error('FTMO positions command disappeared');

    if (data.status === 'completed') {
      return data.result && typeof data.result === 'object'
        ? data.result as Record<string, unknown>
        : {};
    }

    if (data.status === 'failed' || data.status === 'expired') {
      throw new Error(String(data.error || `FTMO positions command ${data.status}`));
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`FTMO positions response timed out after ${timeoutMs}ms`);
}

export async function getFtmoPositionsForUser(userId: string): Promise<FtmoPositionsSnapshot> {
  const terminal = await latestConnectedTerminal(userId);
  const commandId = await enqueueReadCommand(terminal.accountLogin, terminal.terminalId);
  const raw = await waitForResult(commandId);
  const rawPositions = Array.isArray(raw.positions) ? raw.positions : [];
  const positions = rawPositions.map(normalizePosition).filter((value): value is FtmoPosition => Boolean(value));
  const positionCount = Math.max(
    0,
    Math.trunc(finite(raw.positionCount, positions.length)),
  );

  return {
    accountLogin: terminal.accountLogin,
    terminalId: terminal.terminalId,
    positionCount,
    positions,
    detailAvailable: rawPositions.length > 0 || positionCount === 0,
    sizeUnit: 'lots',
    raw,
  };
}

export function mt5SymbolToSignalPair(symbol: string): string {
  const compact = String(symbol || '')
    .toUpperCase()
    .replace(/\.SIM$/i, '')
    .replace(/[^A-Z]/g, '');

  if (compact.length === 6) return `${compact.slice(0, 3)}_${compact.slice(3)}`;
  return String(symbol || '').toUpperCase();
}

/** Convert an MT5 volume in lots to notional units using the broker contract. */
export function mt5VolumeToNotionalUnits(volume: number, contractSize: number | null | undefined): number | null {
  const lots = Number(volume);
  const contract = Number(contractSize);
  if (!Number.isFinite(lots) || lots < 0 || !Number.isFinite(contract) || contract <= 0) return null;
  return lots * contract;
}
