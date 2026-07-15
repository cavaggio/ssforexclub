'use client';

import { useActionState, useState } from 'react';
import { saveFtmoConnectionAction, type FtmoActionResult } from '@/app/dashboard/ftmo-actions';
import type { FtmoPlatform } from '@/lib/futuresProvider';

async function wrapper(_prev: FtmoActionResult | null, formData: FormData): Promise<FtmoActionResult> {
  return saveFtmoConnectionAction(formData);
}

const CONNECTORS: Array<{
  value: FtmoPlatform;
  title: string;
  badge: string;
  description: string;
}> = [
  {
    value: 'ctrader',
    title: 'cTrader Open API',
    badge: 'Recommended',
    description: 'Secure OAuth connection for FTMO cTrader accounts.',
  },
  {
    value: 'mt5',
    title: 'MetaTrader 5',
    badge: 'Bridge',
    description: 'Connect through a MetaApi or self-hosted MT5 bridge.',
  },
  {
    value: 'mt4',
    title: 'MetaTrader 4',
    badge: 'Bridge',
    description: 'Connect through a MetaApi or self-hosted MT4 bridge.',
  },
];

export function ConnectFtmoForm() {
  const [state, formAction, pending] = useActionState(wrapper, null);
  const [environment, setEnvironment] = useState<'challenge' | 'verification' | 'funded'>('challenge');
  const [platform, setPlatform] = useState<FtmoPlatform>('ctrader');

  return (
    <section style={panel}>
      <h3 style={{ margin: 0, fontSize: 18 }}>Connect an FTMO account</h3>

      <p style={{ color: 'var(--muted)', marginTop: 8, fontSize: 13, lineHeight: 1.6 }}>
        FTMO currently provides cTrader, MetaTrader 5, and MetaTrader 4 accounts. cTrader connects
        through cTrader ID authorization. MetaTrader accounts require a separate bridge because
        FTMO does not issue a direct REST API token for MT4 or MT5.
      </p>

      <div style={connectorGrid}>
        {CONNECTORS.map((connector) => {
          const selected = connector.value === platform;
          return (
            <button
              key={connector.value}
              type="button"
              onClick={() => setPlatform(connector.value)}
              aria-pressed={selected}
              style={{
                ...connectorCard,
                borderColor: selected ? 'var(--accent)' : 'var(--border)',
                boxShadow: selected ? '0 0 0 1px var(--accent)' : 'none',
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                <strong style={{ color: 'var(--text)', fontSize: 14 }}>{connector.title}</strong>
                <span style={connectorBadge}>{connector.badge}</span>
              </span>
              <span style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.5, textAlign: 'left' }}>
                {connector.description}
              </span>
            </button>
          );
        })}
      </div>

      <div style={notice}>
        {platform === 'ctrader'
          ? 'Signal Stack redirects you to cTrader to approve access. Your FTMO or cTrader password is never entered into or stored by Signal Stack.'
          : `The ${platform.toUpperCase()} API token comes from the configured bridge provider, not from FTMO. Live execution remains disabled until the bridge adapter is completed and validated.`}
      </div>

      {platform === 'ctrader' ? (
        <div style={grid}>
          <Field label="FTMO phase">
            <select
              value={environment}
              onChange={(e) => setEnvironment(e.target.value as 'challenge' | 'verification' | 'funded')}
              style={input}
            >
              <option value="challenge">Challenge</option>
              <option value="verification">Verification</option>
              <option value="funded">FTMO Account</option>
            </select>
          </Field>

          <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: 6 }}>
            <span style={labelStyle}>Secure authorization</span>
            <a
              href={`/api/ftmo/ctrader/connect?environment=${encodeURIComponent(environment)}`}
              style={oauthButton}
            >
              Connect cTrader to Signal Stack
            </a>
          </div>

          <p style={{ gridColumn: '1 / -1', color: 'var(--muted)', fontSize: 12, lineHeight: 1.55, margin: 0 }}>
            After you sign in with your cTrader ID, choose the FTMO account or accounts Signal Stack may access.
            The connection requests trading scope, but order execution remains blocked by Signal Stack until the
            cTrader transport and live-execution safeguards are enabled.
          </p>
        </div>
      ) : (
        <form action={formAction} style={grid}>
          <input type="hidden" name="platform" value={platform} />

          <Field label="FTMO phase">
            <select
              name="environment"
              value={environment}
              onChange={(e) => setEnvironment(e.target.value as 'challenge' | 'verification' | 'funded')}
              style={input}
            >
              <option value="challenge">Challenge</option>
              <option value="verification">Verification</option>
              <option value="funded">FTMO Account</option>
            </select>
          </Field>

          <Field label="FTMO account login">
            <input
              name="accountId"
              type="text"
              required
              style={input}
              autoComplete="off"
              placeholder="MetaTrader login number"
            />
          </Field>

          <Field label="FTMO server">
            <input
              name="server"
              type="text"
              required
              style={input}
              autoComplete="off"
              placeholder="Shown in FTMO account credentials"
            />
          </Field>

          <Field label="MetaApi account ID">
            <input name="bridgeAccountId" type="text" required style={input} autoComplete="off" />
          </Field>

          <Field label="MetaApi API token">
            <input name="bridgeToken" type="password" required style={input} autoComplete="off" />
          </Field>

          <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
            <button type="submit" disabled={pending} style={{ ...btn, cursor: pending ? 'wait' : 'pointer' }}>
              {pending ? 'Saving…' : `Save ${platform.toUpperCase()} connection`}
            </button>
          </div>
        </form>
      )}

      {platform !== 'ctrader' && state && !state.ok && <div style={errBox}>{state.error}</div>}
      {platform !== 'ctrader' && state && state.ok && <div style={okBox}>FTMO connection profile saved.</div>}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={labelStyle}>{label}</span>
      {children}
    </label>
  );
}

const panel: React.CSSProperties = {
  background: 'var(--panel)',
  border: '1px solid var(--border)',
  borderRadius: 10,
  padding: 24,
};

const connectorGrid: React.CSSProperties = {
  marginTop: 18,
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
  gap: 12,
};

const connectorCard: React.CSSProperties = {
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  padding: 14,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  fontFamily: 'inherit',
  cursor: 'pointer',
};

const connectorBadge: React.CSSProperties = {
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

const notice: React.CSSProperties = {
  marginTop: 14,
  padding: '11px 13px',
  borderRadius: 7,
  background: '#33270d',
  border: '1px solid #5c481a',
  color: '#e0b341',
  fontSize: 12,
  lineHeight: 1.5,
};

const grid: React.CSSProperties = {
  marginTop: 16,
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
  gap: 12,
};

const labelStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--muted)',
  textTransform: 'uppercase',
  letterSpacing: '1px',
  fontWeight: 700,
};

const input: React.CSSProperties = {
  padding: '10px 12px',
  minHeight: 40,
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  color: 'var(--text)',
  borderRadius: 6,
  fontFamily: 'inherit',
  fontSize: 13,
};

const oauthButton: React.CSSProperties = {
  ...input,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'var(--accent)',
  color: '#001a33',
  textDecoration: 'none',
  fontWeight: 800,
};

const btn: React.CSSProperties = {
  padding: '10px 24px',
  background: 'var(--accent)',
  color: '#001a33',
  border: 'none',
  borderRadius: 6,
  fontFamily: 'inherit',
  fontWeight: 700,
  fontSize: 13,
};

const errBox: React.CSSProperties = {
  marginTop: 12,
  padding: '10px 14px',
  background: '#320d0d',
  border: '1px solid #5c1a1a',
  color: 'var(--bad)',
  borderRadius: 6,
  fontSize: 13,
};

const okBox: React.CSSProperties = {
  marginTop: 12,
  padding: '10px 14px',
  background: '#0d3320',
  border: '1px solid #1a5c38',
  color: 'var(--good)',
  borderRadius: 6,
  fontSize: 13,
};
