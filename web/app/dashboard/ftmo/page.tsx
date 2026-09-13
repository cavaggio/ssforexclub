import { auth } from '@clerk/nextjs/server';
import { listFuturesConnections } from '@/lib/futuresProvider';
import { ConnectFtmoForm } from '@/components/connect-ftmo-form';
import { FtmoOrderTestControl } from '@/components/ftmo-order-test-control';
import { getFtmoExecutionReadiness } from '@/lib/ftmoAutoExecution';

export const dynamic = 'force-dynamic';

function on(value: string | undefined) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

function Badge({ active }: { active: boolean }) {
  return (
    <span style={{
      padding: '4px 10px',
      borderRadius: 20,
      fontSize: 12,
      fontWeight: 700,
      background: active ? '#0d3320' : '#33270d',
      border: active ? '1px solid #1a5c38' : '1px solid #5c481a',
      color: active ? 'var(--good)' : '#e0b341',
    }}>
      {active ? 'Enabled' : 'Disabled'}
    </span>
  );
}

function Row({ label, active }: { label: string; active: boolean }) {
  return (
    <div style={card}>
      <strong>{label}</strong>
      <Badge active={active} />
    </div>
  );
}

function environmentLabel(value: string | null | undefined) {
  if (value === 'challenge') return 'FTMO Challenge';
  if (value === 'verification') return 'Verification';
  if (value === 'funded') return 'FTMO Account / Funded';
  return value || '—';
}

function marketClosedMessage(now = new Date()): string | null {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now);
  const read = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const weekday = read('weekday');
  const minutes = (parseInt(read('hour'), 10) % 24) * 60 + parseInt(read('minute'), 10);
  const closed = weekday === 'Sat' ||
    (weekday === 'Fri' && minutes >= 17 * 60) ||
    (weekday === 'Sun' && minutes < 17 * 60 + 5);
  return closed
    ? 'The FX market is currently inside the weekend close. The controlled test is blocked until after Sunday 5:05 PM ET.'
    : null;
}

export default async function FtmoPage() {
  const { userId } = await auth();
  const connections = userId
    ? await listFuturesConnections(userId, 'ftmo').catch(() => [])
    : [];
  const active = connections[0] ?? null;

  const ftmoEnabled = on(process.env.FTMO_ENABLED);
  const autoTrade = on(process.env.FTMO_AUTO_TRADE_ENABLED);
  const liveExecution = on(process.env.FTMO_LIVE_EXECUTION_ENABLED);
  const useV3 = process.env.FTMO_USE_V3_ENGINE == null || on(process.env.FTMO_USE_V3_ENGINE);
  const useICT = process.env.FTMO_USE_ICT_ENGINE == null || on(process.env.FTMO_USE_ICT_ENGINE);
  const configuredProvider = String(process.env.FTMO_PROVIDER || '').trim().toLowerCase();
  const hasLegacyProviderSetting = Boolean(configuredProvider && configuredProvider !== 'mt5_ea');
  const readiness = userId && active
    ? await getFtmoExecutionReadiness({ userId, accountLogin: active.accountId }).catch(() => null)
    : null;

  return (
    <div style={{ maxWidth: 960, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 24 }}>
      <section style={panel}>
        <h2 style={{ margin: 0, fontSize: 20 }}>FTMO / MetaTrader 5 EA</h2>

        <p style={{ color: 'var(--muted)', marginTop: 8, lineHeight: 1.6 }}>
          Signal Stack uses the outbound SignalStackBridge Expert Advisor. The EA polls the authenticated command queue,
          executes only on the selected FTMO MT5 account, and reports results back to Signal Stack. No FTMO master password
          is stored in Signal Stack and FTMO execution never falls back to OANDA.
        </p>

        <p style={{ color: '#e0b341', fontWeight: 700, marginTop: 12 }}>
          Safe activation sequence: connected EA → bridge v1.23 + risk policy v1.21 heartbeat → one 0.01-lot order test with resolved order/deal/position IDs → verify broker result → enable autonomous FTMO execution.
        </p>

        {hasLegacyProviderSetting && (
          <p style={{ color: '#e0b341', marginTop: 10, fontSize: 12 }}>
            A legacy FTMO_PROVIDER value is configured. Set FTMO_PROVIDER=mt5_ea in Railway and Vercel so the environment matches the active outbound-EA architecture.
          </p>
        )}
      </section>

      <section style={panel}>
        <h3 style={{ margin: 0, fontSize: 16 }}>Connector / Activation Status</h3>

        <div style={grid}>
          <div style={card}>
            <strong>Provider</strong>
            <span>MetaTrader 5 EA</span>
          </div>

          <Row label="FTMO connector" active={ftmoEnabled} />
          <Row label="EA heartbeat" active={readiness?.terminalConnected === true && readiness?.heartbeatFresh === true} />
          <Row label="Bridge v1.23" active={readiness?.bridgeVersionCompatible === true} />
          <Row label="Risk policy v1.21" active={readiness?.policyVersionCompatible === true} />
          <Row label="Order test verified" active={readiness?.orderTestVerified === true} />
          <Row label="Live execution gate" active={liveExecution} />
          <Row label="Auto trade gate" active={autoTrade} />
          <Row label="V3 engine" active={useV3} />
          <Row label="ICT engine" active={useICT} />
          <Row label="Saved FTMO connection" active={Boolean(active)} />

          <div style={card}>
            <strong>Bridge heartbeat</strong>
            <span>{readiness?.terminalBridgeVersion ?? '—'}</span>
          </div>

          <div style={card}>
            <strong>Environment</strong>
            <span>{environmentLabel(active?.environment)}</span>
          </div>

          <div style={card}>
            <strong>MT5 Login</strong>
            <span>{active?.accountId ?? '—'}</span>
          </div>
        </div>

        {readiness && (
          <div style={{ marginTop: 14, padding: 12, border: '1px dashed var(--border)', borderRadius: 8, fontSize: 12, lineHeight: 1.55, color: readiness.ready ? 'var(--good)' : 'var(--muted)' }}>
            <strong>{readiness.ready ? 'FTMO autonomous execution is armed.' : 'FTMO autonomous execution remains fail-closed.'}</strong>{' '}
            {readiness.reason}. Risk policy: 1% initial risk, 0.5% after an SL for the rest of the NY trading day, 2% daily equity-loss lock, 10-pip SL, +10-pip breakeven, 80% at +15 pips, final 20% at +18 pips, 1.56R blended reward/risk.
          </div>
        )}
      </section>

      <FtmoOrderTestControl
        connected={readiness?.terminalConnected === true && readiness?.heartbeatFresh === true && readiness?.bridgeVersionCompatible === true && readiness?.policyVersionCompatible === true}
        liveExecutionEnabled={liveExecution}
        orderTestVerified={readiness?.orderTestVerified === true}
        marketClosedMessage={marketClosedMessage()}
      />

      <ConnectFtmoForm />
    </div>
  );
}

const panel: React.CSSProperties = {
  background: 'var(--panel)',
  border: '1px solid var(--border)',
  borderRadius: 10,
  padding: 24,
};

const grid: React.CSSProperties = {
  marginTop: 16,
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
  gap: 12,
};

const card: React.CSSProperties = {
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  padding: 14,
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: 12,
};
