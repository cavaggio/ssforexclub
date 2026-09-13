import crypto from 'node:crypto';
import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { getUserTradingSettings } from '@/lib/userTradingSettings';
import { listBrokerConnectionsForUser } from '@/lib/brokerConnections';
import { enqueueFtmoOrderTest } from '@/lib/ftmoAutoExecution';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ALLOWED_TEST_SYMBOLS = new Set(['EUR_USD', 'GBP_USD', 'USD_JPY', 'GBP_JPY']);
const CONFIRMATION = 'PLACE FTMO TEST ORDER';
const MAX_TEST_VOLUME = 0.01;

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ ok: false, error: 'Unauthenticated' }, { status: 401 });

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch {}

  if (String(body.confirmation || '').trim() !== CONFIRMATION) {
    return NextResponse.json({
      ok: false,
      error: `Type ${CONFIRMATION} exactly to authorize one minimum-volume test order.`,
    }, { status: 400 });
  }

  const symbol = String(body.symbol || '').trim().toUpperCase();
  const side = String(body.side || '').trim().toLowerCase();
  const requestedVolume = Number(body.volume);
  if (!ALLOWED_TEST_SYMBOLS.has(symbol)) {
    return NextResponse.json({ ok: false, error: 'Test symbol must be EUR_USD, GBP_USD, USD_JPY, or GBP_JPY.' }, { status: 400 });
  }
  if (side !== 'buy' && side !== 'sell') {
    return NextResponse.json({ ok: false, error: 'Test side must be buy or sell.' }, { status: 400 });
  }
  if (!Number.isFinite(requestedVolume) || requestedVolume <= 0 || requestedVolume > MAX_TEST_VOLUME) {
    return NextResponse.json({ ok: false, error: 'FTMO order test volume must be greater than 0 and no more than 0.01 lots.' }, { status: 400 });
  }

  const settings = await getUserTradingSettings(userId);
  if (settings.activeBroker !== 'ftmo') {
    return NextResponse.json({ ok: false, error: 'FTMO must be the active trading mode before an FTMO order test.' }, { status: 409 });
  }

  const connections = await listBrokerConnectionsForUser(userId);
  const connection = connections.find((item) =>
    item.id === settings.activeBrokerConnectionId &&
    item.broker === 'ftmo' &&
    item.environment === settings.activeEnvironment &&
    item.isActive
  ) ?? connections.find((item) =>
    item.broker === 'ftmo' &&
    item.environment === settings.activeEnvironment &&
    item.isActive
  ) ?? null;

  if (!connection) {
    return NextResponse.json({ ok: false, error: 'No active FTMO connection matches the selected FTMO environment.' }, { status: 409 });
  }

  const confirmationId = `${Date.now()}-${crypto.randomUUID()}`;
  const result = await enqueueFtmoOrderTest({
    userId,
    accountLogin: connection.accountId,
    symbol,
    side: side as 'buy' | 'sell',
    volume: requestedVolume,
    confirmationId,
  });

  if (!result.ok) {
    return NextResponse.json({ ok: false, blocked: true, error: result.reason }, { status: 409 });
  }

  return NextResponse.json({
    ok: true,
    queued: true,
    commandId: result.commandId,
    terminalId: result.terminalId,
    symbol,
    side,
    volume: requestedVolume,
    message: 'Minimum-volume FTMO test order queued. Watch MT5 and the command result before enabling autonomous execution.',
  });
}
