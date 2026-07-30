import { auth } from '@clerk/nextjs/server';
import { listFuturesConnections } from '@/lib/futuresProvider';
import { ConnectFtmoForm } from '@/components/connect-ftmo-form';

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
  if (value === 'free_trial') return 'FTMO Free Trial';
  if (value === 'challenge') return 'FTMO Challenge';
  if (value === 'verification') return 'Verification';
  if (value === 'funded') return 'FTMO Account / Funded';
  return value || '—';
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
  const staleProvider = String(process.env.FTMO_PROVIDER || '').trim().toLowerCase();
  const hasLegacyProviderSetting = Boolean(staleProvider && staleProvider !== 'mt5_bridge');

  return (
    <div style={{ maxWidth: 960, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 24 }}>
      <section style={panel}>
        <h2 style={{ margin: 0, fontSize: 20 }}>FTMO / MetaTrader 5 Bridge</h2>

        <p style={{ color: 'var(--muted)', marginTop: 8, lineHeight: 1.6 }}>
          Signal Stack sends signed trade requests to a private bridge running beside the FTMO MT5 terminal on a
          Windows VPS. FTMO credentials never fall back to OANDA, cTrader, or another broker connection.
        </p>

        <p style={{ color: '#e0b341', fontWeight: 700, marginTop: 12 }}>
          Safe mode: keep live execution disabled until bridge health, account identity, positions, and test orders are verified.
        </p>

        {hasLegacyProviderSetting && (
          <p style={{ color: '#e0b341', marginTop: 10, fontSize: 12 }}>
            A legacy FTMO_PROVIDER value is still configured, but it is ignored. This page and execution path use MetaTrader 5 Bridge only. Set FTMO_PROVIDER=mt5_bridge in Railway and Vercel to remove the stale setting.
          </p>
        )}
      </section>

      <section style={panel}>
        <h3 style={{ margin: 0, fontSize: 16 }}>Connector Status</h3>

        <div style={grid}>
          <div style={card}>
            <strong>Provider</strong>
            <span>MetaTrader 5 Bridge</span>
          </div>

          <Row label="FTMO connector" active={ftmoEnabled} />
          <Row label="Auto trade" active={autoTrade} />
          <Row label="Live execution" active={liveExecution} />
          <Row label="V3 engine" active={useV3} />
          <Row label="ICT engine" active={useICT} />
          <Row label="Saved MT5 bridge" active={Boolean(active)} />

          <div style={card}>
            <strong>Environment</strong>
            <span>{environmentLabel(active?.environment)}</span>
          </div>

          <div style={card}>
            <strong>MT5 Login</strong>
            <span>{active?.accountId ?? '—'}</span>
          </div>
        </div>
      </section>

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
