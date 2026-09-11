'use client';

import { useActionState, useState } from 'react';
import { saveFtmoConnectionAction, type FtmoActionResult } from '@/app/dashboard/ftmo-actions';

async function wrapper(_prev: FtmoActionResult | null, formData: FormData): Promise<FtmoActionResult> {
  return saveFtmoConnectionAction(formData);
}

type FtmoEnvironment = 'challenge' | 'verification' | 'funded';

const setupSteps = [
  { title: 'MT5 Login Number', source: 'Prop account credentials', directions: 'Copy the numeric MT5 login exactly.' },
  { title: 'Exact MT5 Server', source: 'Prop account credentials', directions: 'Copy the MT5 server exactly as displayed. Do not shorten it.' },
  { title: 'Terminal ID', source: 'Signal Stack', directions: 'Use a unique name for this terminal, for example ftmo-primary.' },
  { title: 'EA Token', source: 'Signal Stack', directions: 'After saving, Signal Stack generates a one-time terminal token. Copy it into the Signal Stack MT5 EA inputs.' },
  { title: 'MetaTrader VPS', source: 'MT5', directions: 'Attach the Signal Stack EA to a chart, enable Algo Trading, allow WebRequest to your Signal Stack HTTPS domain, then migrate Experts to MetaTrader VPS.' },
];

export function ConnectFtmoForm() {
  const [state, formAction, pending] = useActionState(wrapper, null);
  const [environment, setEnvironment] = useState<FtmoEnvironment>('verification');

  return (
    <>
      <section style={panel}>
        <h3 style={{ margin: 0, fontSize: 16 }}>Connect MetaTrader 5 EA</h3>
        <p style={{ color: 'var(--muted)', marginTop: 8, fontSize: 13, lineHeight: 1.6 }}>
          Signal Stack now uses an outbound MT5 Expert Advisor connection designed for MetaTrader Virtual Hosting. You no longer need a separate Windows HTTPS bridge, bridge URL, API key, HMAC secret, or MT5 password in Signal Stack.
        </p>

        <form action={formAction} style={grid}>
          <Field label="Environment">
            <select name="environment" value={environment} onChange={(e) => setEnvironment(e.target.value as FtmoEnvironment)} style={input}>
              <option value="challenge">Challenge</option>
              <option value="verification">Verification</option>
              <option value="funded">Funded</option>
            </select>
          </Field>
          <Field label="MT5 Login Number">
            <input name="accountLogin" inputMode="numeric" pattern="[0-9]+" required style={input} autoComplete="off" placeholder="Numeric MT5 login" />
          </Field>
          <Field label="Exact MT5 Server">
            <input name="server" type="text" required style={input} autoComplete="off" placeholder="Copy exact server" />
          </Field>
          <Field label="Terminal ID">
            <input name="terminalId" type="text" style={input} autoComplete="off" defaultValue="ftmo-primary" />
          </Field>
          <div style={{ gridColumn: '1 / -1', ...noteBox }}>
            Keep your MT5 master password only inside MetaTrader. After saving, copy the generated EA token into the Signal Stack EA. Live execution remains blocked until the EA heartbeat confirms the saved login, server, and terminal ID.
          </div>
          <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
            <button type="submit" disabled={pending} style={{ ...btn, cursor: pending ? 'wait' : 'pointer' }}>
              {pending ? 'Generating…' : 'Generate MT5 EA connection'}
            </button>
          </div>
        </form>

        {state && !state.ok && <div style={errBox}>{state.error}</div>}
        {state && state.ok && (
          <div style={okBox}>
            <strong>MT5 EA connection created.</strong>
            <div style={{ marginTop: 8 }}>Terminal ID: <code>{state.terminalId}</code></div>
            <div style={{ marginTop: 6, overflowWrap: 'anywhere' }}>EA token: <code>{state.terminalToken}</code></div>
            <div style={{ marginTop: 8 }}>Copy this token now. Regenerating the connection rotates it.</div>
          </div>
        )}
      </section>

      <section style={panel}>
        <h3 style={{ margin: 0, fontSize: 16 }}>MetaTrader VPS setup</h3>
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
          <strong style={{ color: '#e0b341' }}>Important</strong>
          <p style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.6, margin: '7px 0 0' }}>
            In MT5 Virtual Hosting, migrate <strong>Experts</strong> or <strong>All</strong>. A “Signal only” migration will not run the Signal Stack EA.
          </p>
        </div>
      </section>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}><span style={labelStyle}>{label}</span>{children}</label>;
}

const panel: React.CSSProperties = { background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 10, padding: 24 };
const grid: React.CSSProperties = { marginTop: 16, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 };
const guideGrid: React.CSSProperties = { marginTop: 16, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 12 };
const guideCard: React.CSSProperties = { background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 8, padding: 14, display: 'flex', flexDirection: 'column', gap: 7 };
const sourceLabel: React.CSSProperties = { color: 'var(--accent)', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.8px' };
const adminBox: React.CSSProperties = { marginTop: 14, padding: '12px 14px', background: '#33270d33', border: '1px solid #5c481a', borderRadius: 8 };
const labelStyle: React.CSSProperties = { fontSize: 12, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '1px', fontWeight: 700 };
const input: React.CSSProperties = { padding: '10px 12px', background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 6, fontFamily: 'inherit', fontSize: 13 };
const noteBox: React.CSSProperties = { padding: '10px 14px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--muted)', fontSize: 12, lineHeight: 1.55 };
const btn: React.CSSProperties = { padding: '10px 24px', background: 'var(--accent)', color: '#001a33', border: 'none', borderRadius: 6, fontFamily: 'inherit', fontWeight: 700, fontSize: 13 };
const errBox: React.CSSProperties = { marginTop: 12, padding: '10px 14px', background: '#320d0d', border: '1px solid #5c1a1a', color: 'var(--bad)', borderRadius: 6, fontSize: 13 };
const okBox: React.CSSProperties = { marginTop: 12, padding: '10px 14px', background: '#0d3320', border: '1px solid #1a5c38', color: 'var(--good)', borderRadius: 6, fontSize: 13, lineHeight: 1.5 };
