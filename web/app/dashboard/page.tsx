/**
 * web/app/dashboard/page.tsx
 *
 * Main trading dashboard. Shows the user's active environment summary, trade
 * activity, risk controls, Auto AI controls, and the rich scanner panel.
 */

import Link from 'next/link';
import { auth } from '@clerk/nextjs/server';
import { listBrokerConnectionsForUser } from '@/lib/brokerConnections';
import { resolveActiveBrokerForUser, toClientSafeBrokerStatus } from '@/lib/brokerResolver';
import { ScannerStatusCard } from '@/components/scanner-status-card';
import { AutoAiTradingToggle } from '@/components/auto-ai-trading-toggle';
import { RiskManagementPanel } from '@/components/risk-management-panel';
import { TradeActivityLog } from '@/components/trade-activity-log';

export default async function DashboardPage() {
  const { userId } = await auth();
  if (!userId) return null;

  let connections: Awaited<ReturnType<typeof listBrokerConnectionsForUser>> = [];
  try {
    connections = await listBrokerConnectionsForUser(userId);
  } catch {
    // Surface the error in the active-mode card below; don't bring the page down.
  }

  const resolvedBroker = await resolveActiveBrokerForUser(userId);
  const brokerStatus = toClientSafeBrokerStatus(resolvedBroker);
  const isLive = brokerStatus.isLiveTrading;
  const hasAnyConnection = connections.length > 0;
  const modeLabel = isLive
    ? 'Live'
    : brokerStatus.activeEnvironment === 'practice'
      ? 'Practice'
      : 'Paper';

  return (
    <div
      style={{
        maxWidth: 1100,
        margin: '0 auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 20,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 26, letterSpacing: '-0.3px' }}>Trading dashboard</h1>
          <p style={{ color: 'var(--muted)', marginTop: 4, fontSize: 13 }}>
            Live scanner output, trade activity, and active-trade management for the broker
            account you have selected in <Link href="/dashboard/settings">Settings</Link>.
          </p>
        </div>
      </div>

      <section
        style={{
          background: 'var(--panel)',
          border: isLive ? '1px solid var(--bad)' : '1px solid var(--border)',
          borderRadius: 10,
          padding: '16px 20px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 16,
          flexWrap: 'wrap',
          boxShadow: isLive ? '0 0 0 2px rgba(255,77,77,0.15) inset' : undefined,
        }}
      >
        <div>
          <div style={{ fontSize: 12, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '1px' }}>
            Active mode
          </div>
          <div
            style={{
              marginTop: 4,
              fontSize: 22,
              fontWeight: 800,
              color: isLive ? 'var(--bad)' : 'var(--text)',
            }}
          >
            {brokerStatus.activeBroker ? brokerStatus.activeBroker.toUpperCase() : '—'}{' '}
            <span style={{ color: 'var(--muted)', fontWeight: 600 }}>·</span> {modeLabel}
          </div>
          <div style={{ marginTop: 4, fontSize: 12, color: 'var(--muted)', maxWidth: 600, lineHeight: 1.5 }}>
            {brokerStatus.reason}
          </div>
        </div>
        <Link
          href="/dashboard/settings"
          style={{
            padding: '8px 16px',
            border: '1px solid var(--border)',
            borderRadius: 6,
            color: 'var(--text)',
            textDecoration: 'none',
            fontSize: 13,
            fontWeight: 600,
            background: 'var(--bg)',
            whiteSpace: 'nowrap',
          }}
        >
          Manage in Settings →
        </Link>
      </section>

      {!hasAnyConnection && (
        <section
          style={{
            background: '#1f1100',
            border: '1px solid #5c4400',
            borderRadius: 10,
            padding: 24,
          }}
        >
          <h3 style={{ margin: 0, fontSize: 16, color: 'var(--warn)' }}>
            Connect a broker to get started
          </h3>
          <p style={{ color: 'var(--text)', marginTop: 8, fontSize: 13, lineHeight: 1.5 }}>
            The trading dashboard activates once you link an OANDA practice or live
            account in <Link href="/dashboard/settings">Settings</Link>. Practice mode is
            available immediately and risk-free.
          </p>
        </section>
      )}

      {hasAnyConnection && <RiskManagementPanel />}
      {hasAnyConnection && <AutoAiTradingToggle />}

      {/* Always visible near the top: documents every open, close, and partial close
          for the signed-in user's traded pairs. */}
      <TradeActivityLog hasBroker={hasAnyConnection} />

      <ScannerStatusCard hasBroker={hasAnyConnection} />
    </div>
  );
}
