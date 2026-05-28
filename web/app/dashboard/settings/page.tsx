/**
 * web/app/dashboard/settings/page.tsx
 *
 * Settings page — broker accounts, paper/live toggle, live-trading
 * acknowledgement, and per-environment status. Previously lived at /dashboard;
 * relocated here on 2026-05-27 so /dashboard can host the actual trading
 * experience.
 *
 * Same Clerk-auth guard as /dashboard — the middleware + the parent
 * dashboard/layout.tsx both enforce it.
 */

import { auth } from '@clerk/nextjs/server';
import { listBrokerConnectionsForUser } from '@/lib/brokerConnections';
import { summarizeEnvironments } from '@/lib/environments';
import { resolveActiveBrokerForUser, toClientSafeBrokerStatus } from '@/lib/brokerResolver';
import { TradingModeToggle } from '@/components/trading-mode-toggle';
import { ConnectBrokerForm } from '@/components/connect-broker-form';
import { LiveAckCard } from '@/components/live-ack-card';

export default async function SettingsPage() {
  const { userId } = await auth();
  if (!userId) return null;

  let connections: Awaited<ReturnType<typeof listBrokerConnectionsForUser>> = [];
  let connectionError: string | null = null;
  try {
    connections = await listBrokerConnectionsForUser(userId);
  } catch (err) {
    connectionError = err instanceof Error ? err.message : String(err);
  }

  const envSummary = summarizeEnvironments(connections);
  // `resolvedBroker` carries a server-only `getCredentials` callback — never
  // pass it directly to a `"use client"` component. `toClientSafeBrokerStatus`
  // strips the callback so the toggle can receive a plain-JSON object that
  // React can serialize across the Server → Client boundary.
  const resolvedBroker = await resolveActiveBrokerForUser(userId);
  const brokerStatus   = toClientSafeBrokerStatus(resolvedBroker);

  return (
    <div
      style={{
        maxWidth: 960,
        margin: '0 auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 24,
      }}
    >
      <section
        style={{
          background: 'var(--panel)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          padding: 24,
        }}
      >
        <h2 style={{ margin: 0, fontSize: 20 }}>Settings</h2>
        <p style={{ color: 'var(--muted)', marginTop: 8 }}>
          Connect broker accounts and choose your trading mode. The selection here is
          read by every scan, trade and reassessment the bot runs on your behalf.
        </p>
      </section>

      {/* Per-user trading-mode toggle (Paper / Live). Renders only when the user has
          at least one broker connection so they don't see a useless toggle. */}
      {connections.length > 0 && (
        <TradingModeToggle resolved={brokerStatus} />
      )}

      {/* Live-trading risk acknowledgement — one-time. */}
      {!brokerStatus.liveTradingAcknowledged && connections.some((c) => c.environment === 'live') && (
        <LiveAckCard />
      )}

      <ConnectBrokerForm />

      <section
        style={{
          background: 'var(--panel)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          padding: 24,
        }}
      >
        <h3 style={{ margin: 0, fontSize: 16 }}>Trading environments</h3>
        <p style={{ color: 'var(--muted)', marginTop: 8, fontSize: 13 }}>
          Paper trading is always available. Live trading turns on automatically when a
          live broker account is linked and the platform-level live-execution flag is
          enabled.
        </p>

        <div
          style={{
            marginTop: 16,
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: 12,
          }}
        >
          <EnvCard
            label="Paper Trading"
            value={envSummary.paperTradingAvailable ? 'Available' : 'Unavailable'}
            valueColor="var(--good)"
            note="OANDA practice · Alpaca paper"
          />
          <EnvCard
            label="Live Trading"
            value={envSummary.liveTradingEnabled ? 'Enabled' : 'Not enabled'}
            valueColor={envSummary.liveTradingEnabled ? 'var(--good)' : 'var(--muted)'}
            note={
              envSummary.liveExecutionAllowedByPlatform
                ? envSummary.liveTradingEnabled
                  ? 'Live broker account linked'
                  : 'No live broker account linked yet'
                : 'Platform-level live execution disabled'
            }
          />
          <EnvCard
            label="Active Environment"
            value={envSummary.activeEnvironment}
            valueColor="var(--text)"
            note="Defaults to paper when nothing is linked."
          />
        </div>
      </section>

      <section
        style={{
          background: 'var(--panel)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          padding: 24,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>Broker connections</h3>
          <span style={{ color: 'var(--muted)', fontSize: 12 }}>{connections.length} active</span>
        </div>

        {connectionError ? (
          <p style={{ color: 'var(--bad)', marginTop: 12, fontSize: 13 }}>
            Could not load broker connections: {connectionError}
          </p>
        ) : connections.length === 0 ? (
          <p style={{ color: 'var(--muted)', marginTop: 12, fontSize: 13 }}>
            No broker accounts connected yet. Use the form above to add one.
          </p>
        ) : (
          <ul style={{ marginTop: 16, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {connections.map((c) => (
              <li
                key={c.id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  padding: '12px 16px',
                  background: 'var(--bg)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                }}
              >
                <span>
                  <strong>{c.broker.toUpperCase()}</strong>
                  <span style={{ color: 'var(--muted)', marginLeft: 8 }}>
                    {c.environment} &middot; {c.accountId}
                  </span>
                </span>
                <span style={{ color: c.isActive ? 'var(--good)' : 'var(--muted)' }}>
                  {c.isActive ? 'active' : 'disabled'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function EnvCard({
  label, value, valueColor, note,
}: {
  label: string;
  value: string;
  valueColor: string;
  note: string;
}) {
  return (
    <div
      style={{
        padding: '14px 16px',
        background: 'var(--bg)',
        border: '1px solid var(--border)',
        borderRadius: 8,
      }}
    >
      <div style={{ fontSize: 12, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '1px' }}>
        {label}
      </div>
      <div style={{ marginTop: 6, fontSize: 16, fontWeight: 700, color: valueColor }}>
        {value}
      </div>
      <div style={{ marginTop: 4, fontSize: 12, color: 'var(--muted)' }}>{note}</div>
    </div>
  );
}
