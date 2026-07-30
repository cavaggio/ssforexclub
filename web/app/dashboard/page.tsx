/**
 * web/app/dashboard/page.tsx
 *
 * Main trading dashboard. Shows the user's active environment summary, trade
 * activity, risk controls, Auto AI controls, V3 watch status, and scanner.
 */

import Link from 'next/link';
import { auth } from '@clerk/nextjs/server';
import { listBrokerConnectionsForUser } from '@/lib/brokerConnections';
import {
  resolveActiveBrokerForUser,
  toClientSafeBrokerStatus,
  type ClientSafeBrokerStatus,
} from '@/lib/brokerResolver';
import { ScannerStatusCard } from '@/components/scanner-status-card';
import { ScannerWatchStatus } from '@/components/scanner-watch-status';
import { AutoAiTradingToggle } from '@/components/auto-ai-trading-toggle';
import { RiskManagementPanel } from '@/components/risk-management-panel';
import { TradeActivityLog } from '@/components/trade-activity-log';

function unavailableBrokerStatus(): ClientSafeBrokerStatus {
  return {
    activeBroker: null,
    activeEnvironment: 'practice',
    activeConnectionId: null,
    isLiveTrading: false,
    isPaperTrading: true,
    liveTradingAcknowledged: false,
    environmentSource: 'fallback_dev_env',
    platformLiveTradingEnabled: false,
    brokerCredentialStatus: 'error',
    baseUrl: null,
    reason: 'Broker status is temporarily unavailable. The dashboard remains accessible while the connection is retried.',
  };
}

export default async function DashboardPage() {
  const { userId } = await auth();
  if (!userId) return null;

  // These reads are display dependencies, not authorization gates. A temporary
  // Supabase/credential-resolution failure must degrade the affected cards rather
  // than reject the complete /dashboard server render.
  const [connectionsResult, brokerResult] = await Promise.allSettled([
    listBrokerConnectionsForUser(userId),
    resolveActiveBrokerForUser(userId),
  ]);

  if (connectionsResult.status === 'rejected') {
    console.error('[dashboard] broker connection list failed:', connectionsResult.reason);
  }
  if (brokerResult.status === 'rejected') {
    console.error('[dashboard] active broker resolution failed:', brokerResult.reason);
  }

  const connections = connectionsResult.status === 'fulfilled' ? connectionsResult.value : [];
  const brokerStatus = brokerResult.status === 'fulfilled'
    ? toClientSafeBrokerStatus(brokerResult.value)
    : unavailableBrokerStatus();
  const brokerStatusUnavailable = brokerResult.status === 'rejected';
  const isLive = brokerStatus.isLiveTrading;
  const hasAnyConnection = connections.length > 0 || brokerStatus.brokerCredentialStatus === 'ready';
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

      {brokerStatusUnavailable && (
        <section
          role="status"
          style={{
            background: 'rgba(255, 178, 36, 0.08)',
            border: '1px solid var(--warn)',
            borderRadius: 10,
            padding: '12px 16px',
            color: 'var(--text)',
            fontSize: 12,
            lineHeight: 1.5,
          }}
        >
          <strong style={{ color: 'var(--warn)' }}>Connection status temporarily unavailable.</strong>{' '}
          The page loaded in safe mode. Refresh to retry the broker-status read; no order settings were changed.
        </section>
      )}

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

      {!hasAnyConnection && !brokerStatusUnavailable && (
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

      <TradeActivityLog hasBroker={hasAnyConnection} />

      <ScannerWatchStatus hasBroker={hasAnyConnection} />
      <ScannerStatusCard hasBroker={hasAnyConnection} />
    </div>
  );
}
