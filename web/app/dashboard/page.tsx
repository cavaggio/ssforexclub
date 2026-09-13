/**
 * web/app/dashboard/page.tsx
 *
 * Main trading dashboard. Shows the user's active environment summary, trade
 * activity, risk controls, Auto AI controls, V3 watch status, scanner, and
 * connected FTMO / MT5 terminal identity when available.
 */

import Link from 'next/link';
import { auth } from '@clerk/nextjs/server';
import { listBrokerConnectionsForUser } from '@/lib/brokerConnections';
import { getServerSupabase } from '@/lib/db';
import {
  resolveActiveBrokerForUser,
  toClientSafeBrokerStatus,
  type ClientSafeBrokerStatus,
} from '@/lib/brokerResolver';
import { ScannerStatusCard } from '@/components/scanner-status-card';
import { ScannerWatchStatus } from '@/components/scanner-watch-status';
import { AutoAiTradingToggle } from '@/components/auto-ai-trading-toggle';
import { AutoCloseToggle } from '@/components/auto-close-toggle';
import { RiskManagementPanel } from '@/components/risk-management-panel';
import { TradeActivityLog } from '@/components/trade-activity-log';

type FtmoTerminalStatus = {
  account_login: string;
  server: string;
  terminal_id: string;
  status: string;
  last_heartbeat_at: string | null;
  last_error: string | null;
};

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

async function loadLatestFtmoTerminal(userId: string): Promise<FtmoTerminalStatus | null> {
  const supabase = getServerSupabase();
  const { data, error } = await supabase
    .from('mt5_ea_terminals')
    .select('account_login,server,terminal_id,status,last_heartbeat_at,last_error')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`loadLatestFtmoTerminal: ${error.message}`);
  return data ? (data as FtmoTerminalStatus) : null;
}

function environmentLabel(value: string | null | undefined): string {
  if (value === 'challenge') return 'Challenge';
  if (value === 'verification') return 'Verification';
  if (value === 'funded') return 'Funded';
  if (value === 'evaluation') return 'Evaluation';
  if (value === 'sim') return 'Sim';
  if (value === 'practice') return 'Practice';
  if (value === 'paper') return 'Paper';
  if (value === 'live') return 'Live';
  return value || '—';
}

function terminalStatusColor(status: string): string {
  if (status === 'connected') return 'var(--good)';
  if (status === 'disabled') return 'var(--bad)';
  return 'var(--warn)';
}

function formatHeartbeat(value: string | null): string {
  if (!value) return 'Waiting for first heartbeat';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}

function KV({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.6 }}>
        {label}
      </span>
      <span style={{ fontSize: 13, fontWeight: 700, color: color || 'var(--text)', fontFamily: 'var(--mono, monospace)' }}>
        {value}
      </span>
    </div>
  );
}

export default async function DashboardPage() {
  const { userId } = await auth();
  if (!userId) return null;

  // These reads are display dependencies, not authorization gates. A temporary
  // Supabase/credential-resolution failure must degrade the affected cards rather
  // than reject the complete /dashboard server render.
  const [connectionsResult, brokerResult, ftmoTerminalResult] = await Promise.allSettled([
    listBrokerConnectionsForUser(userId),
    resolveActiveBrokerForUser(userId),
    loadLatestFtmoTerminal(userId),
  ]);

  if (connectionsResult.status === 'rejected') {
    console.error('[dashboard] broker connection list failed:', connectionsResult.reason);
  }
  if (brokerResult.status === 'rejected') {
    console.error('[dashboard] active broker resolution failed:', brokerResult.reason);
  }
  if (ftmoTerminalResult.status === 'rejected') {
    console.error('[dashboard] FTMO terminal read failed:', ftmoTerminalResult.reason);
  }

  const connections = connectionsResult.status === 'fulfilled' ? connectionsResult.value : [];
  const brokerStatus = brokerResult.status === 'fulfilled'
    ? toClientSafeBrokerStatus(brokerResult.value)
    : unavailableBrokerStatus();
  const ftmoTerminal = ftmoTerminalResult.status === 'fulfilled' ? ftmoTerminalResult.value : null;
  const ftmoConnection = ftmoTerminal
    ? connections.find((c) => c.broker === 'ftmo' && c.accountId === ftmoTerminal.account_login && c.isActive) ?? null
    : null;
  const brokerStatusUnavailable = brokerResult.status === 'rejected';
  const isLive = brokerStatus.isLiveTrading;
  const hasAnyConnection = connections.length > 0 || brokerStatus.brokerCredentialStatus === 'ready';
  const modeLabel = environmentLabel(brokerStatus.activeEnvironment);

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

      {ftmoTerminal && (
        <section
          style={{
            background: 'var(--panel)',
            border: ftmoTerminal.status === 'connected' ? '1px solid rgba(34,197,94,.45)' : '1px solid var(--border)',
            borderRadius: 12,
            padding: 18,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 800 }}>FTMO Prop Account</div>
              <div style={{ marginTop: 4, fontSize: 12, color: 'var(--muted)' }}>
                MetaTrader 5 EA bridge · account identity and terminal health
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span
                style={{
                  padding: '5px 10px',
                  borderRadius: 999,
                  fontSize: 11,
                  fontWeight: 800,
                  textTransform: 'uppercase',
                  color: terminalStatusColor(ftmoTerminal.status),
                  border: `1px solid ${terminalStatusColor(ftmoTerminal.status)}`,
                }}
              >
                {ftmoTerminal.status}
              </span>
              <Link
                href="/dashboard/ftmo"
                style={{
                  padding: '7px 12px',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  color: 'var(--text)',
                  textDecoration: 'none',
                  fontSize: 12,
                  fontWeight: 700,
                  background: 'var(--bg)',
                }}
              >
                Manage FTMO →
              </Link>
            </div>
          </div>

          <div
            style={{
              marginTop: 16,
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
              gap: 14,
            }}
          >
            <KV label="Environment" value={environmentLabel(ftmoConnection?.environment)} />
            <KV label="MT5 Login" value={ftmoTerminal.account_login} />
            <KV label="MT5 Server" value={ftmoTerminal.server || '—'} />
            <KV label="Terminal ID" value={ftmoTerminal.terminal_id} />
            <KV
              label="EA Connection"
              value={ftmoTerminal.status === 'connected' ? 'Connected' : 'Waiting'}
              color={terminalStatusColor(ftmoTerminal.status)}
            />
            <KV label="Last Heartbeat" value={formatHeartbeat(ftmoTerminal.last_heartbeat_at)} />
          </div>

          {ftmoTerminal.last_error && (
            <div style={{ marginTop: 14, fontSize: 12, color: 'var(--bad)' }}>
              MT5 bridge warning: {ftmoTerminal.last_error}
            </div>
          )}

          {ftmoTerminal.status !== 'connected' && (
            <div style={{ marginTop: 14, fontSize: 12, color: 'var(--warn)', lineHeight: 1.5 }}>
              FTMO is saved but the EA has not completed a valid heartbeat yet. Auto trade and live execution should remain disabled until this card shows Connected.
            </div>
          )}
        </section>
      )}

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
            The trading dashboard activates once you link a supported broker account in{' '}
            <Link href="/dashboard/settings">Settings</Link> or connect FTMO from the{' '}
            <Link href="/dashboard/ftmo">FTMO page</Link>.
          </p>
        </section>
      )}

      {hasAnyConnection && <RiskManagementPanel />}
      {hasAnyConnection && <AutoAiTradingToggle />}
      {hasAnyConnection && <AutoCloseToggle />}

      <TradeActivityLog hasBroker={hasAnyConnection} />

      <ScannerWatchStatus hasBroker={hasAnyConnection} />
      <ScannerStatusCard hasBroker={hasAnyConnection} />
    </div>
  );
}
