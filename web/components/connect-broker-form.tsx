/**
 * web/components/connect-broker-form.tsx
 *
 * Connect a broker account (OANDA-first; Alpaca scaffold present).
 * The form posts to the saveBrokerConnectionAction Server Action.
 * The API token field is `type="password"` to keep it off-screen and the
 * value never leaves the request body — there's no client fetch.
 */

'use client';

import { useActionState, useState } from 'react';
import { saveBrokerConnectionAction, type ActionResult } from '@/app/dashboard/actions';

async function actionWrapper(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  return saveBrokerConnectionAction(formData);
}

export function ConnectBrokerForm() {
  const [state, formAction, pending] = useActionState(actionWrapper, null);
  const [broker, setBroker] = useState<'oanda' | 'alpaca'>('oanda');
  const [environment, setEnvironment] = useState<'practice' | 'paper' | 'live'>('practice');

  const envOptions = broker === 'oanda'
    ? [
        { value: 'practice', label: 'Practice (demo / paper)' },
        { value: 'live',     label: 'Live' },
      ]
    : [
        { value: 'paper', label: 'Paper' },
        { value: 'live',  label: 'Live' },
      ];

  return (
    <section
      style={{
        background: 'var(--panel)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        padding: 24,
      }}
    >
      <h3 style={{ margin: 0, fontSize: 16 }}>Connect broker account</h3>
      <p style={{ color: 'var(--muted)', marginTop: 8, fontSize: 13 }}>
        Credentials are encrypted server-side with AES-256-GCM before storage. The token
        is never returned to the browser and never written to logs.
      </p>

      <form
        action={formAction}
        autoComplete="off"
        style={{
          marginTop: 16,
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: 12,
        }}
      >
        <FieldLabel label="Broker">
          <select
            name="broker"
            value={broker}
            onChange={(e) => {
              const v = e.target.value as 'oanda' | 'alpaca';
              setBroker(v);
              setEnvironment(v === 'oanda' ? 'practice' : 'paper');
            }}
            style={selectStyle}
          >
            <option value="oanda">OANDA</option>
            <option value="alpaca" disabled>Alpaca (coming soon)</option>
          </select>
        </FieldLabel>

        <FieldLabel label="Environment">
          <select
            name="environment"
            value={environment}
            onChange={(e) => setEnvironment(e.target.value as 'practice' | 'paper' | 'live')}
            style={selectStyle}
          >
            {envOptions.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </FieldLabel>

        <FieldLabel label={broker === 'oanda' ? 'OANDA Account ID' : 'Account ID'}>
          <input
            name="accountId"
            type="text"
            placeholder={broker === 'oanda' ? '101-001-39311050-001' : 'Broker account ID'}
            required
            style={inputStyle}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            inputMode={broker === 'oanda' ? 'numeric' : 'text'}
            pattern={broker === 'oanda' ? '\\d{3}-\\d{3}-\\d{6,12}-\\d{3}' : undefined}
            title={broker === 'oanda' ? 'Use the OANDA account ID shown in OANDA, not your email address.' : undefined}
          />
          {broker === 'oanda' && (
            <span style={{ color: 'var(--muted)', fontSize: 11 }}>
              Use the hyphenated OANDA account number, not your email address.
            </span>
          )}
        </FieldLabel>

        <FieldLabel label="API Token">
          <input
            name="token"
            type="password"
            required
            style={inputStyle}
            autoComplete="new-password"
          />
        </FieldLabel>

        <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
          <button
            type="submit"
            disabled={pending}
            style={{
              padding: '10px 24px',
              background: 'var(--accent)',
              color: '#001a33',
              border: 'none',
              borderRadius: 6,
              fontFamily: 'inherit',
              fontWeight: 700,
              fontSize: 13,
              cursor: pending ? 'wait' : 'pointer',
            }}
          >
            {pending ? 'Saving…' : 'Save connection'}
          </button>
        </div>
      </form>

      {state && !state.ok && (
        <div
          style={{
            marginTop: 12,
            padding: '10px 14px',
            background: '#320d0d',
            border: '1px solid #5c1a1a',
            color: 'var(--bad)',
            borderRadius: 6,
            fontSize: 13,
          }}
        >
          {state.error}
        </div>
      )}
      {state && state.ok && (
        <div
          style={{
            marginTop: 12,
            padding: '10px 14px',
            background: '#0d3320',
            border: '1px solid #1a5c38',
            color: 'var(--good)',
            borderRadius: 6,
            fontSize: 13,
          }}
        >
          Broker connection saved.
        </div>
      )}
    </section>
  );
}

function FieldLabel({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span
        style={{
          fontSize: 12,
          color: 'var(--muted)',
          textTransform: 'uppercase',
          letterSpacing: '1px',
          fontWeight: 700,
        }}
      >
        {label}
      </span>
      {children}
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  padding: '10px 12px',
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  color: 'var(--text)',
  borderRadius: 6,
  fontFamily: 'inherit',
  fontSize: 13,
};
const selectStyle = inputStyle;
