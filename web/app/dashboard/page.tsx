/**
 * web/app/dashboard/page.tsx
 *
 * Main trading dashboard. Shows the user's active environment summary at the
 * top and reserves the rest of the page for the scanner UI.
 *
 * NOTE — scanner content is a deliberate placeholder for now. The legacy
 * Signal Stack scanner UI lives in src/ (Vite app) and is tightly coupled to
 * the Express scanner's /api/oanda/scan endpoint, which is not yet
 * user-scoped — it still reads broker credentials from process.env on the
 * server side. Wiring it through a per-user Next.js proxy is the next
 * iteration; until that lands, the placeholder is honest about it.
 *
 * Broker / environment management lives at /dashboard/settings.
 */

import Link from 'next/link';
import { auth } from '@clerk/nextjs/server';
import { listBrokerConnectionsForUser } from '@/lib/brokerConnections';
import { resolveActiveBrokerForUser, toClientSafeBrokerStatus } from '@/lib/brokerResolver';
import { ScannerStatusCard } from '@/components/scanner-status-card';

export default async function DashboardPage() {
  const { userId } = await auth();
  if (!userId) return null;

  let connections: Awaited<ReturnType<typeof listBrokerConnectionsForUser>> = [];
  try {
    connections = await listBrokerConnectionsForUser(userId);
  } catch {
    // Surface the error in the active-mode card below; don't bring the page down.
  }
  // Strip the server-only `getCredentials` callback before any client-bound
  // read. Even though this page doesn't pass the whole object to a client
  // component today, using the client-safe projection keeps the boundary
  // explicit and prevents a future regression.
  const resolvedBroker = await resolveActiveBrokerForUser(userId);
  const brokerStatus   = toClientSafeBrokerStatus(resolvedBroker);

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
      {/* ── Page header ─────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 26, letterSpacing: '-0.3px' }}>Trading dashboard</h1>
          <p style={{ color: 'var(--muted)', marginTop: 4, fontSize: 13 }}>
            Live scanner output, signal cards, and active-trade management for the broker
            account you have selected in <Link href="/dashboard/settings">Settings</Link>.
          </p>
        </div>
      </div>

      {/* ── Active-mode strip — always visible so it's clear which account
            the bot is acting on. Red border in live mode. */}
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

      {/* ── First-run nudge if no broker connected ──────────────────────── */}
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

      {/* Live scanner — calls /api/scanner/scan with the user's resolved
          broker credentials. The Route Handler returns 409 with the
          resolver's reason if creds are missing for the selected mode. */}
      <ScannerStatusCard hasBroker={hasAnyConnection} />

      {/* ── Placeholder cards for future content blocks ─────────────────── */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
          gap: 16,
        }}
      >
        <PlaceholderCard
          title="Recent signals"
          note="Qualified setups from your last scan."
        />
        <PlaceholderCard
          title="Open trades"
          note="Active positions and management plans."
        />
        <PlaceholderCard
          title="30-min reassessment"
          note="Trailing, partials, TP reduction and invalidation."
        />
      </div>
    </div>
  );
}

function PlaceholderCard({ title, note }: { title: string; note: string }) {
  return (
    <section
      style={{
        background: 'var(--panel)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        padding: 20,
      }}
    >
      <h3 style={{ margin: 0, fontSize: 14 }}>{title}</h3>
      <p style={{ color: 'var(--muted)', marginTop: 6, fontSize: 12, lineHeight: 1.5 }}>
        {note}
      </p>
      <div
        style={{
          marginTop: 14,
          padding: 16,
          background: 'var(--bg)',
          border: '1px dashed var(--border)',
          borderRadius: 6,
          fontSize: 12,
          color: 'var(--muted)',
          textAlign: 'center',
        }}
      >
        Awaiting scanner proxy.
      </div>
    </section>
  );
}
