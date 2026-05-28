/**
 * web/app/dashboard/page.tsx
 *
 * Authenticated dashboard. Scaffolding only — placeholder cards. The next
 * iteration will:
 *
 *   - render a "Connect Broker" wizard that writes to broker_connections
 *   - call the Express scanner (../server) for the user's signals
 *   - render the ForexSignalStackTab UI we ported from the Vite app
 *
 * For now we just confirm auth and list the user's current broker connections
 * (will be empty for fresh accounts). Every read is server-side, scoped to the
 * authenticated user via `auth().userId` — no frontend-supplied user IDs.
 */

import { auth } from '@clerk/nextjs/server';
import { listBrokerConnectionsForUser } from '@/lib/brokerConnections';
import { summarizeEnvironments } from '@/lib/environments';
import { resolveActiveBrokerForUser, toClientSafeBrokerStatus } from '@/lib/brokerResolver';
import { TradingModeToggle } from '@/components/trading-mode-toggle';
import { ConnectBrokerForm } from '@/components/connect-broker-form';
import { LiveAckCard } from '@/components/live-ack-card';

export default async function DashboardPage() {
  const { userId } = await auth();
  // Type-narrow — middleware + layout already enforce this is non-null in prod.
  if (!userId) return null;

  let connections: Awaited<ReturnType<typeof listBrokerConnectionsForUser>> = [];
  let connectionError: string | null = null;
  try {
    connections = await listBrokerConnectionsForUser(userId);
  } catch (err) {
    connectionError = err instanceof Error ? err.message : String(err);
  }

  const envSummary = summarizeEnvironments(connections);
  const resolvedBroker = await resolveActiveBrokerForUser(userId);
  const clientSafeBrokerStatus = toClientSafeBrokerStatus(resolvedBroker);
  // Suppress unused-var lint — used by future API consumers that POST this object back to the scanner.
  void clientSafeBrokerStatus;

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
        <h2 style={{ margin: 0, fontSize: 20 }}>Welcome to Signal Stack</h2>
        <p style={{ color: 'var(--muted)', marginTop: 8 }}>
          You&apos;re signed in. Broker connections, signals, and trades will appear here
          once you link an account.
        </p>
      </section>

      {/* ── Per-user trading-mode toggle (Paper / Live) — Part 2 of the
          2026-05-27 user-environment-toggle spec. Renders only when the user
          has at least one broker connection so they don't see a useless toggle
          before connecting an account. */}
      {connections.length > 0 && (
        <TradingModeToggle resolved={resolvedBroker} />
      )}

      {/* Live-trading risk acknowledgement — shown until the user accepts it
          once. Switching back to practice does NOT reset the flag. */}
      {!resolvedBroker.liveTradingAcknowledged && connections.some((c) => c.environment === 'live') && (
        <LiveAckCard />
      )}

      {/* Connect-broker form — Part 3. Always rendered so a user can add
          additional broker accounts after their first connection. */}
      <ConnectBrokerForm />

      {/* ── Trading environments (paper / live status) ─────────────────────
          Read-only summary. Live-account UI is intentionally untouched. */}
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
          Paper trading is always available. Live trading turns on automatically when a live
          broker account is linked and the platform-level live-execution flag is enabled.
        </p>

        <div
          style={{
            marginTop: 16,
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: 12,
          }}
        >
          <div
            style={{
              padding: '14px 16px',
              background: 'var(--bg)',
              border: '1px solid var(--border)',
              borderRadius: 8,
            }}
          >
            <div style={{ fontSize: 12, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '1px' }}>
              Paper Trading
            </div>
            <div style={{ marginTop: 6, fontSize: 16, fontWeight: 700, color: 'var(--good)' }}>
              {envSummary.paperTradingAvailable ? 'Available' : 'Unavailable'}
            </div>
            <div style={{ marginTop: 4, fontSize: 12, color: 'var(--muted)' }}>
              OANDA practice · Alpaca paper
            </div>
          </div>

          <div
            style={{
              padding: '14px 16px',
              background: 'var(--bg)',
              border: '1px solid var(--border)',
              borderRadius: 8,
            }}
          >
            <div style={{ fontSize: 12, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '1px' }}>
              Live Trading
            </div>
            <div
              style={{
                marginTop: 6,
                fontSize: 16,
                fontWeight: 700,
                color: envSummary.liveTradingEnabled ? 'var(--good)' : 'var(--muted)',
              }}
            >
              {envSummary.liveTradingEnabled ? 'Enabled' : 'Not enabled'}
            </div>
            <div style={{ marginTop: 4, fontSize: 12, color: 'var(--muted)' }}>
              {envSummary.liveExecutionAllowedByPlatform
                ? envSummary.liveTradingEnabled
                  ? 'Live broker account linked'
                  : 'No live broker account linked yet'
                : 'Platform-level live execution disabled'}
            </div>
          </div>

          <div
            style={{
              padding: '14px 16px',
              background: 'var(--bg)',
              border: '1px solid var(--border)',
              borderRadius: 8,
            }}
          >
            <div style={{ fontSize: 12, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '1px' }}>
              Active Environment
            </div>
            <div style={{ marginTop: 6, fontSize: 16, fontWeight: 700 }}>
              {envSummary.activeEnvironment}
            </div>
            <div style={{ marginTop: 4, fontSize: 12, color: 'var(--muted)' }}>
              Defaults to paper when nothing is linked.
            </div>
          </div>
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
          <span style={{ color: 'var(--muted)', fontSize: 12 }}>
            {connections.length} active
          </span>
        </div>

        {connectionError ? (
          <p style={{ color: 'var(--bad)', marginTop: 12, fontSize: 13 }}>
            Could not load broker connections: {connectionError}
          </p>
        ) : connections.length === 0 ? (
          <p style={{ color: 'var(--muted)', marginTop: 12, fontSize: 13 }}>
            No broker accounts connected yet. The connect-broker wizard ships in the next
            release.
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
