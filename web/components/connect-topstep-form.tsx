/**
 * web/components/connect-topstep-form.tsx
 *
 * Connect a Topstep (TopstepX) account via the ProjectX Gateway API key.
 * Credential set { userName, apiKey } — both required. apiKey is type=password,
 * encrypted AES-256-GCM server-side, never returned to the browser.
 */

'use client';

import { useActionState, useState } from 'react';
import { saveTopstepConnectionAction, type ActionResult } from '@/app/dashboard/futures-actions';

async function wrapper(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  return saveTopstepConnectionAction(formData);
}

export function ConnectTopstepForm() {
  const [state, formAction, pending] = useActionState(wrapper, null);
  const [environment, setEnvironment] = useState<'evaluation' | 'funded'>('evaluation');

  return (
    <section style={panel}>
      <h3 style={{ margin: 0, fontSize: 16 }}>Connect Topstep account</h3>
      <p style={{ color: 'var(--muted)', marginTop: 8, fontSize: 13 }}>
        Generate an API key in your TopstepX settings. It is encrypted server-side with
        AES-256-GCM and never returned to the browser. Live execution remains disabled
        unless Topstep&apos;s automation rules permit cloud execution.
      </p>

      <form action={formAction} style={grid}>
        <Field label="Account type">
          <select name="environment" value={environment} onChange={(e) => setEnvironment(e.target.value as 'evaluation' | 'funded')} style={input}>
            <option value="evaluation">Evaluation / Combine (sim)</option>
            <option value="funded">Funded</option>
          </select>
        </Field>
        <Field label="Username (userName)"><input name="userName" type="text" required style={input} autoComplete="off" /></Field>
        <Field label="API Key (apiKey)"><input name="apiKey" type="password" required style={input} autoComplete="off" /></Field>

        <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
          <button type="submit" disabled={pending} style={{ ...btn, cursor: pending ? 'wait' : 'pointer' }}>
            {pending ? 'Saving…' : 'Save Topstep connection'}
          </button>
        </div>
      </form>

      {state && !state.ok && <div style={errBox}>{state.error}</div>}
      {state && state.ok && <div style={okBox}>Topstep connection saved.</div>}
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
