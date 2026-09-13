import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { getUserTradingSettings } from '@/lib/userTradingSettings';
import { listBrokerConnectionsForUser } from '@/lib/brokerConnections';
import { getFtmoExecutionReadiness } from '@/lib/ftmoAutoExecution';

export const dynamic = 'force-dynamic';

export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ ok: false, error: 'Unauthenticated' }, { status: 401 });

  const settings = await getUserTradingSettings(userId);
  const connections = await listBrokerConnectionsForUser(userId);
  const active = connections.find((connection) =>
    connection.id === settings.activeBrokerConnectionId &&
    connection.broker === 'ftmo' &&
    connection.isActive
  ) ?? connections.find((connection) => connection.broker === 'ftmo' && connection.isActive) ?? null;

  if (!active) {
    return NextResponse.json({
      ok: true,
      activeBroker: settings.activeBroker,
      activeEnvironment: settings.activeEnvironment,
      connected: false,
      ready: false,
      reason: 'No active FTMO connection is saved',
    });
  }

  const readiness = await getFtmoExecutionReadiness({ userId, accountLogin: active.accountId });
  return NextResponse.json({
    ok: true,
    activeBroker: settings.activeBroker,
    activeEnvironment: settings.activeEnvironment,
    accountLogin: active.accountId,
    connectionId: active.id,
    ...readiness,
  });
}
