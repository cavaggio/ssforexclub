/**
 * web/components/connect-ninjatrader-form.tsx
 *
 * Connect a NinjaTrader futures account. Multi-field credential set
 * { name, password, appId, appVersion, cid, sec } — all required. Posts to the
 * saveNinjaTraderConnectionAction Server Action; password/sec are type=password
 * and never returned to the browser (encrypted AES-256-GCM server-side).
 */

'use client';

import { useActionState, useState } from 'react';
import { saveNinjaTraderConnectionAction, type ActionResult } from '@/app/dashboard/futures-actions';

async function wrapper(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  return saveNinjaTraderConnectionAction(formData);
}

export function ConnectNinjaTraderForm() {
  const [state, formAction, pending] = useActionState(wrapper, null);
  const [environment, setEnvironment] = useState<'sim' | 'live'>('sim');

  return (
    <section style={panel}>
      <h3 style={{ margin: 0, fontSize: 16 }}>Connect NinjaTrader account</h3>
      <p style={{ color: 'var(--muted)', marginTop: 8, fontSize: 13 }}>
        Credentials are encrypted server-side with AES-256-GCM before storage and never
        returned to the browser. Live execution stays disabled until enabled by the platform.
      </p>

      <form action={formAction} style={grid}>
        <Field label="Environment">
          <select name="environment" value={environment} onChange={(e) => setEnvironment(e.target.value as 'sim' | 'live')} style={input}>
            <option value="sim">Simulated / Paper</option>
            <option value="live">Live</option>
          </select>
        </Field>
        <Field label="Username (name)"><input name="name" type="text" required style={input} autoComplete="off" /></Field>
        <Field label="Password"><input name="password" type="password" required style={input} autoComplete="off" /></Field>
        <Field label="App ID (appId)"><input name="appId" type="text" required style={input} autoComplete="off" placeholder="Your App Name" /></Field>
        <Field label="App Version (appVersion)"><input name="appVersion" type="text" required style={input} autoComplete="off" placeholder="1.0" /></Field>
        <Field label="Client ID (cid)"><input name="cid" type="text" required style={input} autoComplete="off" /></Field>
        <Field label="Secret (sec)"><input name="sec" type="password" required style={input} autoComplete="off" /></Field>

        <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
          <button type="submit" disabled={pending} style={{ ...btn, cursor: pending ? 'wait' : 'pointer' }}>
            {pending ? 'Saving…' : 'Save NinjaTrader connection'}
          </button>
        </div>
      </form>

      {state && !state.ok && <div style={errBox}>{state.error}</div>}
      {state && state.ok && <div style={okBox}>NinjaTrader connection saved.</div>}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 12, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '1px', fontWeight: 700 }}>{label}</span>
      {children}
    </label>
  );
}

const panel: React.CSSProperties = { background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 10, padding: 24 };
const grid: React.CSSProperties = { marginTop: 16, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 };
const input: React.CSSProperties = { padding: '10px 12px', background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 6, fontFamily: 'inherit', fontSize: 13 };
const btn: React.CSSProperties = { padding: '10px 24px', background: 'var(--accent)', color: '#001a33', border: 'none', borderRadius: 6, fontFamily: 'inherit', fontWeight: 700, fontSize: 13 };
const errBox: React.CSSProperties = { marginTop: 12, padding: '10px 14px', background: '#320d0d', border: '1px solid #5c1a1a', color: 'var(--bad)', borderRadius: 6, fontSize: 13 };
const okBox: React.CSSProperties = { marginTop: 12, padding: '10px 14px', background: '#0d3320', border: '1px solid #1a5c38', color: 'var(--good)', borderRadius: 6, fontSize: 13 };
