/**
 * web/app/dashboard/topstep/page.tsx
 *
 * Topstep tab. Separate from OANDA and NinjaTrader. Topstep prohibits
 * cloud/server-side automation, so live execution from app.ssforexclub.com is
 * disabled unless TOPSTEP_CLOUD_EXECUTION_ALLOWED is explicitly turned on AND
 * the live flag is set. Users can still connect + monitor their account.
 */

import { auth } from '@clerk/nextjs/server';
import {
  listFuturesConnections,
  topstepEnabled,
  topstepLiveEnabled,
  topstepCloudExecutionAllowed,
  TOPSTEP_COMPLIANCE_MESSAGE,
} from '@/lib/futuresProvider';
import { getUserTradingSettings } from '@/lib/userTradingSettings';
import { ConnectTopstepForm } from '@/components/connect-topstep-form';
import { FuturesStatusPanel, type FuturesGate } from '@/components/futures-status-panel';

export const dynamic = 'force-dynamic';

export default async function TopstepPage() {
  const { userId } = await auth();
  if (!userId) return null;

  const [connections, settings] = await Promise.all([
    listFuturesConnections(userId, 'topstep').catch(() => []),
    getUserTradingSettings(userId).catch(() => null),
  ]);
  const active = connections[0] ?? null;
  const enabled = topstepEnabled();
  const cloudAllowed = topstepCloudExecutionAllowed();
  // Live execution is permitted by flags ONLY when cloud execution is allowed
  // (compliance) AND the live flag is on.
  const liveFlag = cloudAllowed && topstepLiveEnabled();

  const gate: FuturesGate = {
    enabled,
    liveFlag,
    liveAck: settings?.liveTradingAcknowledged ?? false,
    hasConnection: Boolean(active),
    connectionEnvironment: active?.environment ?? null,
    complianceMessage: !cloudAllowed ? TOPSTEP_COMPLIANCE_MESSAGE : null,
  };

  return (
    <div style={{ maxWidth: 960, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 24 }}>
      <section style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 10, padding: 24 }}>
        <h2 style={{ margin: 0, fontSize: 20 }}>Topstep</h2>
        <p style={{ color: 'var(--muted)', marginTop: 8 }}>
          Connect your Topstep / TopstepX prop-firm account to monitor balance, drawdown and
          positions. Separate from OANDA and NinjaTrader.
        </p>
        <p style={{ color: '#e0b341', marginTop: 12, fontSize: 13, fontWeight: 600 }}>
          {TOPSTEP_COMPLIANCE_MESSAGE}
        </p>
      </section>

      <FuturesStatusPanel provider="topstep" providerLabel="Topstep" gate={gate} />

      <ConnectTopstepForm />
    </div>
  );
}
