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
import { revalidatePath } from 'next/cache';
import { listBrokerConnectionsForUser } from '@/lib/brokerConnections';
import { getServerSupabase } from '@/lib/db';
import { summarizeEnvironments } from '@/lib/environments';
import { resolveActiveBrokerForUser, toClientSafeBrokerStatus, type ClientSafeBrokerStatus } from '@/lib/brokerResolver';
import { formatBrokerConnection } from '@/lib/brokerDisplay';
import { ValidateConnectionsButton } from '@/components/validate-connections-button';
import { TradingModeToggle } from '@/components/trading-mode-toggle';
import { ConnectBrokerForm } from '@/components/connect-broker-form';
import { LiveAckCard } from '@/components/live-ack-card';
import { RemoveBrokerConnectionButton } from '@/components/remove-broker-connection-button';

/**
 * Reactivate a previously disabled broker row without requiring the user to
 * re-enter credentials. The update is scoped by both Clerk user ID and row ID,
 * and resets validation so the next "Re-check connections" performs a fresh
 * broker authentication probe.
 */
async function reactivateBrokerConnectionAction(formData: FormData): Promise<void> {
  'use server';

  const { userId } = await auth();
  if (!userId) throw new Error('Unauthenticated');

  const connectionId = String(formData.get('connectionId') || '').trim();
  if (!connectionId) throw new Error('connectionId is required');

  const supabase = getServerSupabase();
  const { data, error } = await supabase
    .from('broker_connections')
    .update({
      is_active: true,
      validation_status: 'pending',
      last_validated_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', userId)
    .eq('id', connectionId)
    .select('id');

  if (error) throw new Error(`reactivateBrokerConnection: ${error.message}`);
  if (!Array.isArray(data) || data.length !== 1) {
    throw new Error('Broker connection was not found or could not be reactivated');
  }

  revalidatePath('/dashboard/settings');
  revalidatePath('/dashboard');
}

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

  // `resolvedBroker` carries a server-only `getCredentials` callback — never
  // pass it directly to a `"use client"` component. `toClientSafeBrokerStatus`
  // strips the callback so the toggle can receive a plain-JSON object that
  // React can serialize across the Server → Client boundary.
  // Wrapped defensively: a resolver failure must not crash the whole page.
  let brokerStatus: ClientSafeBrokerStatus;
  try {
    brokerStatus = toClientSafeBrokerStatus(await resolveActiveBrokerForUser(userId));
  } catch (err) {
    if (!connectionError) connectionError = err instanceof Error ? err.message : String(err);
    brokerStatus = {
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
      reason: 'Broker status unavailable',
    };
  }
  // The Trading-environments panel MUST reflect what the scanner will actually
  // use. summarizeEnvironments derives from the resolver output, not a parallel
  // calculation, so the panel and the scanner can never disagree.
  const envSummary = summarizeEnvironments(connections, brokerStatus);

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
          Reflects what the scanner will actually use for your account. Live trading
          requires the platform flag, an active live credential, the risk
          acknowledgement, and the live toggle above.
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
            note={describeLiveGate(envSummary)}
          />
          <EnvCard
            label="Active Environment"
            value={envSummary.activeEnvironment}
            valueColor={envSummary.activeEnvironment === 'live' ? 'var(--bad)' : 'var(--text)'}
            note="Mirrors the toggle above — same value the scanner uses."
          />
        </div>

        {/* Detailed gate status — shown when live is partially set up so the
            user can see exactly which step is still missing. */}
        {!envSummary.liveTradingEnabled && envSummary.liveConnectionLinked && (
          <div
            style={{
              marginTop: 14,
              padding: '12px 14px',
              background: 'var(--bg)',
              border: '1px dashed var(--border)',
              borderRadius: 8,
              fontSize: 12,
              color: 'var(--muted)',
              lineHeight: 1.6,
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
            }}
          >
            <strong style={{ color: 'var(--text)' }}>Live gate diagnostic</strong>
            <GateRow ok={envSummary.liveExecutionAllowedByPlatform} label="Platform live flag (PLATFORM_LIVE_TRADING_ENABLED)" />
            <GateRow ok={envSummary.liveConnectionLinked} label="Live broker credential connected" />
            <GateRow ok={envSummary.liveTradingAcknowledged} label="Live-trading risk acknowledged" />
            <GateRow ok={envSummary.userSelectedLive} label="Toggle set to OANDA Live" />
            <div style={{ marginTop: 4, color: 'var(--muted)' }}>
              Resolver says: {envSummary.resolverReason}
            </div>
          </div>
        )}
      </section>

      <section
        style={{
          background: 'var(--panel)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          padding: 24,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>Broker connections</h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <ValidateConnectionsButton />
            <span style={{ color: 'var(--muted)', fontSize: 12 }}>{connections.length} saved</span>
          </div>
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
            {connections.map((c) => {
              const display = formatBrokerConnection(c);
              const removalLabel = `${display.brokerLabel} ${display.environment} account ${display.accountLabel}`;
              return (
                <li
                  key={c.id}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 12,
                    padding: '12px 16px',
                    background: 'var(--bg)',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                  }}
                >
                  <span>
                    <strong>{display.brokerLabel}</strong>
                    <span style={{ color: 'var(--muted)', marginLeft: 8 }}>
                      {display.environment} &middot; {display.accountLabel}
                    </span>
                  </span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    <span style={{ color: statusToneColor(display.statusTone) }}>
                      {display.statusLabel}
                    </span>
                    {!c.isActive && (
                      <form action={reactivateBrokerConnectionAction}>
                        <input type="hidden" name="connectionId" value={c.id} />
                        <button
                          type="submit"
                          style={{
                            padding: '6px 12px',
                            background: 'transparent',
                            color: 'var(--text)',
                            border: '1px solid var(--border)',
                            borderRadius: 6,
                            fontFamily: 'inherit',
                            fontWeight: 700,
                            fontSize: 12,
                            cursor: 'pointer',
                          }}
                        >
                          Reactivate
                        </button>
                      </form>
                    )}
                    <RemoveBrokerConnectionButton connectionId={c.id} accountLabel={removalLabel} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function describeLiveGate(envSummary: {
  liveTradingEnabled: boolean;
  liveExecutionAllowedByPlatform: boolean;
  liveConnectionLinked: boolean;
  liveTradingAcknowledged: boolean;
  userSelectedLive: boolean;
  brokerCredentialStatus: string;
}): string {
  return liveStatusMessageInner(envSummary);
}

// Maps a formatBrokerConnection() status tone to a CSS color. "validation
// pending"/disabled are muted; validated is good; failed is bad. (A DB-active
// row only means "saved", never "authenticated".)
function statusToneColor(tone: string): string {
  if (tone === 'good') return 'var(--good)';
  if (tone === 'bad') return 'var(--bad)';
  return 'var(--muted)';
}

function liveStatusMessageInner(envSummary: {
  liveTradingEnabled: boolean;
  liveExecutionAllowedByPlatform: boolean;
  liveConnectionLinked: boolean;
  liveTradingAcknowledged: boolean;
  userSelectedLive: boolean;
  brokerCredentialStatus: string;
}): string {
  if (envSummary.liveTradingEnabled) return 'Live broker account active — scanner is routing live.';
  if (!envSummary.liveExecutionAllowedByPlatform) return 'Platform-level live execution disabled.';
  if (!envSummary.liveConnectionLinked) return 'No live broker account linked yet.';
  if (!envSummary.liveTradingAcknowledged) return 'Live credential linked — accept the risk warning to unlock.';
  if (!envSummary.userSelectedLive) return 'Live credential ready — flip the toggle above to OANDA Live.';
  if (envSummary.brokerCredentialStatus === 'no_credentials') {
    return 'Live selected but no matching active credential — re-link the live account.';
  }
  return 'Live not active.';
}

function GateRow({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ color: ok ? 'var(--good)' : 'var(--bad)', fontWeight: 700, minWidth: 16 }}>
        {ok ? '✓' : '✗'}
      </span>
      <span style={{ color: ok ? 'var(--text)' : 'var(--muted)' }}>{label}</span>
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
