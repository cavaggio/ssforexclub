/**
 * web/app/dashboard/futures/page.tsx
 *
 * Futures / NinjaTrader tab. Separate from the OANDA forex dashboard — futures
 * never share OANDA's execution path. The connection panel fetches live
 * diagnostics and derives every state (connection / mode / execution) from the
 * shared pure helper, so "Execution enabled" can only appear when every gate
 * passes. Live execution is OFF by default (NINJATRADER_LIVE_EXECUTION_ENABLED).
 */

import { auth } from '@clerk/nextjs/server';
import {
  listFuturesConnections,
  ninjatraderEnabled,
  ninjatraderLiveEnabled,
} from '@/lib/futuresProvider';
import { getUserTradingSettings } from '@/lib/userTradingSettings';
import { ConnectNinjaTraderForm } from '@/components/connect-ninjatrader-form';
import { FuturesStatusPanel, type FuturesGate } from '@/components/futures-status-panel';

export const dynamic = 'force-dynamic';

export default async function FuturesPage() {
  const { userId } = await auth();
  if (!userId) return null;

  const [connections, settings] = await Promise.all([
    listFuturesConnections(userId, 'ninjatrader').catch(() => []),
    getUserTradingSettings(userId).catch(() => null),
  ]);
  const active = connections[0] ?? null;
  const enabled = ninjatraderEnabled();
  const liveFlag = ninjatraderLiveEnabled();
  const isLive = active?.environment === 'live';

  const gate: FuturesGate = {
    enabled,
    liveFlag,
    liveAck: settings?.liveTradingAcknowledged ?? false,
    hasConnection: Boolean(active),
    connectionEnvironment: active?.environment ?? null,
    complianceMessage: isLive && !liveFlag
      ? 'Live NinjaTrader execution is disabled (NINJATRADER_LIVE_EXECUTION_ENABLED). Simulated mode only.'
      : null,
  };

  return (
    <div style={{ maxWidth: 960, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 24 }}>
      <section style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 10, padding: 24 }}>
        <h2 style={{ margin: 0, fontSize: 20 }}>Futures / NinjaTrader</h2>
        <p style={{ color: 'var(--muted)', marginTop: 8 }}>
          Trade index, energy and metals futures through NinjaTrader / Tradovate. This tab is fully
          separate from your OANDA forex setup — no futures order can route through OANDA.
        </p>
      </section>

      <FuturesStatusPanel provider="ninjatrader" providerLabel="NinjaTrader / Tradovate" gate={gate} />

      <ConnectNinjaTraderForm />
    </div>
  );
}
