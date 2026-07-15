import { auth } from '@clerk/nextjs/server';
import { listFuturesConnections, resolveFuturesCredentials } from '@/lib/futuresProvider';
import { ConnectFtmoForm } from '@/components/connect-ftmo-form';

export const dynamic = 'force-dynamic';

type PageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function on(value: string | undefined) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] || '' : value || '';
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

function ConnectorCard({
  title,
  status,
  description,
}: {
  title: string;
  status: string;
  description: string;
}) {
  return (
    <div style={{ ...card, alignItems: 'flex-start', flexDirection: 'column' }}>
      <div style={{ width: '100%', display: 'flex', justifyContent: 'space-between', gap: 12 }}>
        <strong>{title}</strong>
        <span style={statusBadge}>{status}</span>
      </div>
      <span style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.55 }}>{description}</span>
    </div>
  );
}

function connectorLabel(value: unknown): string {
  const platform = String(value || '').toLowerCase();
  if (platform === 'ctrader') return 'cTrader Open API';
  if (platform === 'mt5') return 'MetaTrader 5 via MetaApi';
  if (platform === 'mt4') return 'MetaTrader 4 via MetaApi';
  return '—';
}

export default async function FtmoPage({ searchParams }: PageProps) {
  const { userId } = await auth();
  const params = searchParams ? await searchParams : {};
  const cTraderResult = first(params.ctrader);
  const cTraderMessage = first(params.message);
  const connectedAccounts = first(params.accounts);

  const connections = userId
    ? await listFuturesConnections(userId, 'ftmo').catch(() => [])
    : [];

  const active = connections[0] ?? null;
  const activeDetails = userId && active
    ? await resolveFuturesCredentials(userId, active.id).catch(() => null)
    : null;

  const ftmoEnabled = on(process.env.FTMO_ENABLED);
  const autoTrade = on(process.env.FTMO_AUTO_TRADE_ENABLED);
  const liveExecution = on(process.env.FTMO_LIVE_EXECUTION_ENABLED);
  const useV3 = on(process.env.FTMO_USE_V3_ENGINE);
  const useICT = on(process.env.FTMO_USE_ICT_ENGINE);
  const savedPlatform = connectorLabel(activeDetails?.credentials.platform);

  return (
    <div style={{ maxWidth: 960, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 24 }}>
      {cTraderResult === 'connected' && (
        <div style={successNotice}>
          cTrader connected successfully. {connectedAccounts || 'One or more'} FTMO account(s) were saved securely.
        </div>
      )}

      {cTraderResult === 'error' && (
        <div style={errorNotice}>
          cTrader connection failed: {cTraderMessage || 'Unknown authorization error'}
        </div>
      )}

      <section style={panel}>
        <h2 style={{ margin: 0, fontSize: 22 }}>FTMO Account Connectors</h2>

        <p style={{ color: 'var(--muted)', marginTop: 8, lineHeight: 1.6 }}>
          Connect FTMO accounts through the trading platform assigned to the account. FTMO currently
          supports cTrader, MetaTrader 5, and MetaTrader 4.
        </p>

        <p style={{ color: '#e0b341', fontWeight: 700, marginTop: 12, lineHeight: 1.5 }}>
          Safe mode: cTrader authorization and encrypted account storage are available, but live FTMO
          order execution remains disabled until the trading transport is completed and validated.
        </p>
      </section>

      <section style={panel}>
        <h3 style={{ margin: 0, fontSize: 17 }}>Available connectors</h3>

        <div style={grid}>
          <ConnectorCard
            title="cTrader Open API"
            status="OAuth available"
            description="Native cTrader OAuth/Open API connection. Best path for a cloud-hosted Signal Stack integration."
          />
          <ConnectorCard
            title="MetaTrader 5"
            status="Bridge required"
            description="Uses MetaApi or a self-hosted Windows terminal bridge because MT5 accounts do not expose an FTMO REST token."
          />
          <ConnectorCard
            title="MetaTrader 4"
            status="Bridge required"
            description="Uses MetaApi or a self-hosted Windows terminal bridge because MT4 accounts do not expose an FTMO REST token."
          />
        </div>
      </section>

      <section style={panel}>
        <h3 style={{ margin: 0, fontSize: 17 }}>Connector status</h3>

        <div style={grid}>
          <Row label="FTMO connector" active={ftmoEnabled} />
          <Row label="Auto trade" active={autoTrade} />
          <Row label="Live execution" active={liveExecution} />
          <Row label="V3 engine" active={useV3} />
          <Row label="ICT engine" active={useICT} />
          <Row label="Saved connection" active={Boolean(active)} />

          <div style={card}>
            <strong>Saved accounts</strong>
            <span>{connections.length}</span>
          </div>

          <div style={card}>
            <strong>Saved connector</strong>
            <span>{savedPlatform}</span>
          </div>

          <div style={card}>
            <strong>FTMO phase</strong>
            <span>{active?.environment ?? '—'}</span>
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

const statusBadge: React.CSSProperties = {
  padding: '3px 8px',
  borderRadius: 20,
  background: '#10283b',
  border: '1px solid #24516f',
  color: 'var(--accent)',
  fontSize: 10,
  fontWeight: 800,
  textTransform: 'uppercase',
  letterSpacing: '0.7px',
  whiteSpace: 'nowrap',
};

const successNotice: React.CSSProperties = {
  padding: '12px 16px',
  background: '#0d3320',
  border: '1px solid #1a5c38',
  color: 'var(--good)',
  borderRadius: 8,
  fontSize: 13,
  fontWeight: 700,
};

const errorNotice: React.CSSProperties = {
  padding: '12px 16px',
  background: '#320d0d',
  border: '1px solid #5c1a1a',
  color: 'var(--bad)',
  borderRadius: 8,
  fontSize: 13,
  fontWeight: 700,
};
