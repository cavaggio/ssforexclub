/**
 * web/app/dashboard/futures/page.tsx
 *
 * Futures / NinjaTrader tab. Separate from the OANDA forex dashboard — futures
 * never share OANDA's execution path. Shows connection + execution state and
 * the connect form. Live execution is OFF by default (NINJATRADER_LIVE_EXECUTION_ENABLED).
 */

import { auth } from '@clerk/nextjs/server';
import {
  listFuturesConnections,
  ninjatraderEnabled,
  ninjatraderLiveEnabled,
} from '@/lib/futuresProvider';
import { ConnectNinjaTraderForm } from '@/components/connect-ninjatrader-form';
import { FuturesStatusPanel, type FuturesGate } from '@/components/futures-status-panel';

export const dynamic = 'force-dynamic';

export default async function FuturesPage() {
  const { userId } = await auth();
  if (!userId) return null;

  const connections = await listFuturesConnections(userId, 'ninjatrader').catch(() => []);
  const active = connections[0] ?? null;
  const enabled = ninjatraderEnabled();
  const liveEnabled = ninjatraderLiveEnabled();
  const isLive = active?.environment === 'live';

  // Execution permitted when: provider on, a connection exists, and (sim) OR
  // (live AND the live flag is on).
  const liveExecutionAllowed = Boolean(enabled && active && (!isLive || liveEnabled));

  const gate: FuturesGate = {
    enabled,
    liveExecutionAllowed,
    hasConnection: Boolean(active),
    environment: active?.environment ?? null,
    complianceMessage: !enabled
      ? 'NinjaTrader is currently disabled by the platform (NINJATRADER_FUTURES_ENABLED).'
      : isLive && !liveEnabled
        ? 'Live NinjaTrader execution is disabled (NINJATRADER_LIVE_EXECUTION_ENABLED). Sim mode is available.'
        : null,
  };

  return (
    <div style={{ maxWidth: 960, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 24 }}>
      <section style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 10, padding: 24 }}>
        <h2 style={{ margin: 0, fontSize: 20 }}>Futures / NinjaTrader</h2>
        <p style={{ color: 'var(--muted)', marginTop: 8 }}>
          Trade index, energy and metals futures through NinjaTrader. This tab is fully separate
          from your OANDA forex setup — no futures order can route through OANDA.
        </p>
      </section>

      <FuturesStatusPanel provider="ninjatrader" providerLabel="NinjaTrader / Tradovate" gate={gate} />

      <ConnectNinjaTraderForm />
    </div>
  );
}
