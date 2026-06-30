'use client';

import { useActionState, useState } from 'react';
import { saveFtmoConnectionAction, type FtmoActionResult } from '@/app/dashboard/ftmo-actions';

async function wrapper(_prev: FtmoActionResult | null, formData: FormData): Promise<FtmoActionResult> {
  return saveFtmoConnectionAction(formData);
}

export function ConnectFtmoForm() {
  const [state, formAction, pending] = useActionState(wrapper, null);
  const [environment, setEnvironment] = useState<'challenge' | 'verification' | 'funded'>('challenge');

  return (
    <section style={panel}>
      <h3 style={{ margin: 0, fontSize: 16 }}>Connect FTMO / cTrader account</h3>

      <p style={{ color: 'var(--muted)', marginTop: 8, fontSize: 13 }}>
        Save FTMO/cTrader credentials securely. Secrets are encrypted server-side and never returned to the browser.
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

        <Field label="cTrader Account ID">
          <input name="accountId" type="text" required style={input} autoComplete="off" />
        </Field>

        <Field label="cTrader Client ID">
          <input name="clientId" type="text" required style={input} autoComplete="off" />
        </Field>

        <Field label="cTrader Client Secret">
          <input name="clientSecret" type="password" required style={input} autoComplete="off" />
        </Field>

        <Field label="Access Token">
          <input name="accessToken" type="password" required style={input} autoComplete="off" />
        </Field>

        <Field label="Refresh Token">
          <input name="refreshToken" type="password" required style={input} autoComplete="off" />
        </Field>

        <Field label="API Base URL optional">
          <input name="apiBaseUrl" type="text" style={input} autoComplete="off" placeholder="Optional" />
        </Field>

        <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
          <button type="submit" disabled={pending} style={{ ...btn, cursor: pending ? 'wait' : 'pointer' }}>
            {pending ? 'Saving…' : 'Save FTMO connection'}
          </button>
        </div>
      </form>

      {state && !state.ok && <div style={errBox}>{state.error}</div>}
      {state && state.ok && <div style={okBox}>FTMO connection saved.</div>}
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
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  color: 'var(--text)',
  borderRadius: 6,
  fontFamily: 'inherit',
  fontSize: 13,
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
