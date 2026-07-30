'use client';

import { useActionState, useState } from 'react';
import { saveFtmoConnectionAction, type FtmoActionResult } from '@/app/dashboard/ftmo-actions';

async function wrapper(_prev: FtmoActionResult | null, formData: FormData): Promise<FtmoActionResult> {
  return saveFtmoConnectionAction(formData);
}

const setupSteps = [
  {
    title: 'MT5 Login Number',
    source: 'FTMO Client Area',
    directions: 'Open your FTMO account in the Client Area, open Account MetriX, then Credentials. Copy the numeric Login exactly.',
  },
  {
    title: 'Exact MT5 Server',
    source: 'FTMO Client Area',
    directions: 'In Account MetriX → Credentials, copy the Server exactly as displayed. A similar or shortened server name will not connect.',
  },
  {
    title: 'MT5 Master Password',
    source: 'FTMO Client Area',
    directions: 'Use the master trading password only to sign the Windows/VPS MT5 terminal into the account. Do not enter it on this page. The investor password is read-only and cannot execute trades.',
  },
  {
    title: 'HTTPS Bridge URL',
    source: 'Signal Stack MT5 bridge',
    directions: 'Use the public HTTPS address assigned to the private MT5 bridge running beside the logged-in MT5 terminal on the Windows VPS.',
  },
  {
    title: 'Bridge API Key',
    source: 'Signal Stack MT5 bridge',
    directions: 'Copy the API key configured in that client bridge service. The value entered here must match the bridge-side value exactly.',
  },
  {
    title: 'Bridge HMAC Secret',
    source: 'Signal Stack MT5 bridge',
    directions: 'Copy the long signing secret configured on the same bridge. Use a unique value for each client. It is encrypted after saving and is never shown again.',
  },
  {
    title: 'Terminal ID',
    source: 'Signal Stack MT5 bridge',
    directions: 'Enter the unique identifier assigned to this MT5 terminal, such as ftmo-primary. Each simultaneously connected terminal should use a different ID.',
  },
];

export function ConnectFtmoForm() {
  const [state, formAction, pending] = useActionState(wrapper, null);
  const [environment, setEnvironment] = useState<'challenge' | 'verification' | 'funded'>('challenge');

  return (
    <>
      <section style={panel}>
        <h3 style={{ margin: 0, fontSize: 16 }}>Connect FTMO MetaTrader 5 bridge</h3>

        <p style={{ color: 'var(--muted)', marginTop: 8, fontSize: 13, lineHeight: 1.6 }}>
          These encrypted credentials authorize Signal Stack to your private MT5 bridge. Keep the FTMO master trading
          password only on the Windows VPS bridge; do not enter the investor/read-only password here.
        </p>

        <form action={formAction} style={grid}>
          <Field label="Environment">
            <select
              name="environment"
              value={environment}
              onChange={(e) => setEnvironment(e.target.value as 'challenge' | 'verification' | 'funded')}
              style={input}
            >
              <option value="challenge">Challenge</option>
              <option value="verification">Verification</option>
              <option value="funded">Funded</option>
            </select>
          </Field>

          <Field label="MT5 Login Number">
            <input name="accountLogin" inputMode="numeric" pattern="[0-9]+" required style={input} autoComplete="off" placeholder="From Account MetriX → Credentials" />
          </Field>

          <Field label="Exact MT5 Server">
            <input name="server" type="text" required style={input} autoComplete="off" placeholder="Copy exact FTMO server" />
          </Field>

          <Field label="HTTPS Bridge URL">
            <input name="bridgeUrl" type="url" required style={input} autoComplete="off" placeholder="https://mt5-bridge.example.com" />
          </Field>

          <Field label="Bridge API Key">
            <input name="bridgeApiKey" type="password" required style={input} autoComplete="new-password" placeholder="From bridge administrator" />
          </Field>

          <Field label="Bridge HMAC Secret">
            <input name="bridgeSecret" type="password" minLength={16} required style={input} autoComplete="new-password" placeholder="Unique bridge signing secret" />
          </Field>

          <Field label="Terminal ID">
            <input name="terminalId" type="text" style={input} autoComplete="off" defaultValue="ftmo-primary" />
          </Field>

          <div style={{ gridColumn: '1 / -1', ...noteBox }}>
            The FTMO master password, MetaTrader terminal path, and the same bridge key/secret are configured in the
            bridge service&apos;s Windows VPS <code>.env</code> file.
          </div>

          <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
            <button type="submit" disabled={pending} style={{ ...btn, cursor: pending ? 'wait' : 'pointer' }}>
              {pending ? 'Saving…' : 'Save FTMO MT5 connection'}
            </button>
          </div>
        </form>

        {state && !state.ok && <div style={errBox}>{state.error}</div>}
        {state && state.ok && <div style={okBox}>FTMO MT5 bridge connection saved.</div>}
      </section>

      <section style={panel}>
        <h3 style={{ margin: 0, fontSize: 16 }}>Where to find each connection value</h3>
        <p style={{ color: 'var(--muted)', marginTop: 8, fontSize: 13, lineHeight: 1.6 }}>
          FTMO supplies the trading-account values. Your Signal Stack MT5 bridge deployment supplies the secure connector values.
        </p>

        <div style={guideGrid}>
          {setupSteps.map((step) => (
            <article key={step.title} style={guideCard}>
              <strong style={{ fontSize: 13 }}>{step.title}</strong>
              <span style={sourceLabel}>{step.source}</span>
              <p style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.55, margin: 0 }}>{step.directions}</p>
            </article>
          ))}
        </div>

        <div style={adminBox}>
          <strong style={{ color: '#e0b341' }}>Platform administrator only: Railway encryption key</strong>
          <p style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.6, margin: '7px 0 0' }}>
            <code>FTMO_CREDENTIAL_ENCRYPTION_KEY</code> is not provided by FTMO. Generate it once with <code>openssl rand -hex 32</code>, then add it under Railway → Signal Stack service → Variables and redeploy. Clients must never see or enter this value.
          </p>
        </div>
      </section>
    </>
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

const grid: React.CSSProperties = {
  marginTop: 16,
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
  gap: 12,
};

const guideGrid: React.CSSProperties = {
  marginTop: 16,
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))',
  gap: 12,
};

const guideCard: React.CSSProperties = {
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  padding: 14,
  display: 'flex',
  flexDirection: 'column',
  gap: 7,
};

const sourceLabel: React.CSSProperties = {
  color: 'var(--accent)',
  fontSize: 10,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.8px',
};

const adminBox: React.CSSProperties = {
  marginTop: 14,
  padding: '12px 14px',
  background: '#33270d33',
  border: '1px solid #5c481a',
  borderRadius: 8,
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
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  color: 'var(--text)',
  borderRadius: 6,
  fontFamily: 'inherit',
  fontSize: 13,
};

const noteBox: React.CSSProperties = {
  padding: '10px 14px',
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  color: 'var(--muted)',
  fontSize: 12,
  lineHeight: 1.55,
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
