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
