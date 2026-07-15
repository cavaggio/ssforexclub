/**
 * web/app/dashboard/futures/page.tsx
 *
 * Interactive Brokers + ICT Indices & Gold tab. Futures remain physically
 * separate from the OANDA forex execution path. The legacy internal provider
 * key `ninjatrader` is retained temporarily for route/database compatibility;
 * all user-facing behavior and credentials are IBKR Gateway based.
 */

import { auth } from '@clerk/nextjs/server';
import {
  listFuturesConnections,
  ninjatraderEnabled,
  ninjatraderLiveEnabled,
} from '@/lib/futuresProvider';
import { getUserTradingSettings } from '@/lib/userTradingSettings';
import { ConnectIbkrForm } from '@/components/connect-ibkr-form';
import { FuturesStatusPanel, type FuturesGate } from '@/components/futures-status-panel';
import { IbkrIctEnginePanel } from '@/components/ibkr-ict-engine-panel';

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
      ? 'Live IBKR execution is disabled (IBKR_LIVE_EXECUTION_ENABLED=false). Paper and shadow analysis remain available.'
      : null,
  };

  return (
    <div style={{ maxWidth: 1080, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 24 }}>
      <section style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 10, padding: 24 }}>
        <h2 style={{ margin: 0, fontSize: 20 }}>Interactive Brokers — ICT Indices & Gold</h2>
        <p style={{ color: 'var(--muted)', marginTop: 8, lineHeight: 1.6 }}>
          Analyze and trade CME index futures and COMEX gold through a dedicated ICT engine.
          This tab never routes futures orders through OANDA and never applies forex pip sizing
          to futures contracts.
        </p>
      </section>

      <FuturesStatusPanel provider="ninjatrader" providerLabel="Interactive Brokers" gate={gate} />

      <IbkrIctEnginePanel enabled={enabled} hasConnection={Boolean(active)} />

      <ConnectIbkrForm />
    </div>
  );
}
