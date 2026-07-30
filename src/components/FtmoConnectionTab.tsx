import { FormEvent, useEffect, useState } from 'react';

type ConnectionStatus = {
  connected?: boolean;
  status?: string;
  accountLoginMasked?: string;
  server?: string;
  bridgeUrl?: string;
  terminalId?: string;
  environment?: string;
  accountModel?: string;
  hasApiKey?: boolean;
  hasBridgeSecret?: boolean;
  lastTestedAt?: string | null;
  lastError?: string | null;
  updatedAt?: string | null;
};

const API_BASE = String(import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

function authHeaders() {
  const token = localStorage.getItem('token') || localStorage.getItem('accessToken') || localStorage.getItem('auth_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

const setupSteps = [
  {
    title: '1. FTMO MT5 login',
    source: 'Provided by FTMO',
    directions: 'Open the FTMO Client Area, select the correct account, open Account MetriX, then open Credentials. Copy the Login number exactly.',
  },
  {
    title: '2. Exact FTMO server',
    source: 'Provided by FTMO',
    directions: 'In the same Account MetriX → Credentials section, copy the Server exactly as displayed. Do not guess or shorten the server name.',
  },
  {
    title: '3. MT5 master password',
    source: 'Used only inside MT5',
    directions: 'Log the Windows MT5 terminal into the FTMO account with the master password. The investor/read-only password cannot execute trades. Do not enter the MT5 password in this form.',
  },
  {
    title: '4. Secure bridge URL',
    source: 'Provided by your Signal Stack bridge deployment',
    directions: 'Use the public HTTPS address of the MT5 bridge running beside the Windows MT5 terminal or VPS. It must expose the Signal Stack /v1 bridge endpoints and use a valid TLS certificate.',
  },
  {
    title: '5. Bridge API key',
    source: 'Created by the bridge administrator',
    directions: 'Copy the API key configured on that client’s MT5 bridge. The value entered here must match the bridge-side API key exactly.',
  },
  {
    title: '6. Bridge secret',
    source: 'Created by the bridge administrator',
    directions: 'Copy the long HMAC signing secret configured on the same bridge. Use a unique secret for each client connection. It is encrypted after saving and is never displayed again.',
  },
  {
    title: '7. Terminal ID',
    source: 'Assigned by the bridge administrator',
    directions: 'Enter the unique terminal identifier configured for this MT5 instance, such as ftmo-demo-primary. Each concurrently connected terminal should use a different ID.',
  },
];

export function FtmoConnectionTab() {
  const [form, setForm] = useState({
    accountLogin: '',
    server: '',
    bridgeUrl: '',
    bridgeApiKey: '',
    bridgeSecret: '',
    terminalId: 'ftmo-demo-primary',
    environment: 'free_trial',
    accountModel: 'demo',
  });
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState('');

  async function loadStatus() {
    setLoading(true);
    try {
      const response = await fetch(`${API_BASE}/api/ftmo/connection`, { headers: authHeaders() });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error || 'Unable to load FTMO connection');
      setStatus(body.connection || null);
      if (body.connection) {
        setForm(current => ({
          ...current,
          server: body.connection.server || '',
          bridgeUrl: body.connection.bridgeUrl || '',
          terminalId: body.connection.terminalId || 'ftmo-demo-primary',
          environment: body.connection.environment || 'free_trial',
          accountModel: body.connection.accountModel || 'demo',
        }));
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void loadStatus(); }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setMessage('');
    try {
      const response = await fetch(`${API_BASE}/api/ftmo/connection`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify(form),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error || 'Unable to save FTMO connection');
      setStatus(body.connection);
      setForm(current => ({ ...current, accountLogin: '', bridgeApiKey: '', bridgeSecret: '' }));
      setMessage('FTMO connection saved securely for this login.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  async function testConnection() {
    setTesting(true);
    setMessage('');
    try {
      const response = await fetch(`${API_BASE}/api/ftmo/connection/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error || 'FTMO connection test failed');
      setStatus(body.connection);
      setMessage(body.connection?.connected ? 'FTMO MT5 bridge connected successfully.' : 'Connection test did not pass.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setTesting(false);
    }
  }

  const fieldStyle = { width: '100%', background: '#020817', border: '1px solid #334155', color: '#e2e8f0', borderRadius: 6, padding: '9px 10px', fontSize: 11 };
  const labelStyle = { display: 'block', color: '#94a3b8', fontSize: 9, fontWeight: 700, marginBottom: 5, letterSpacing: '.08em' };

  return <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 340px', gap: 14 }}>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <section style={{ background: '#0f172a', border: '1px solid rgba(14,165,233,.28)', borderRadius: 8, padding: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 800, color: '#f1f5f9', marginBottom: 4 }}>FTMO MT5 Connection</div>
        <div style={{ fontSize: 10, color: '#64748b', lineHeight: 1.5, marginBottom: 16 }}>Connection details are saved per authenticated client. API keys and bridge secrets are encrypted server-side and are never displayed after saving.</div>
        <form onSubmit={save}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <label><span style={labelStyle}>MT5 LOGIN</span><input required inputMode="numeric" value={form.accountLogin} onChange={e => setForm({ ...form, accountLogin: e.target.value })} placeholder={status?.accountLoginMasked || 'Account MetriX login number'} style={fieldStyle}/></label>
            <label><span style={labelStyle}>FTMO SERVER</span><input required value={form.server} onChange={e => setForm({ ...form, server: e.target.value })} placeholder="Copy exact server from Credentials" style={fieldStyle}/></label>
            <label style={{ gridColumn: '1 / -1' }}><span style={labelStyle}>SECURE BRIDGE URL</span><input required type="url" value={form.bridgeUrl} onChange={e => setForm({ ...form, bridgeUrl: e.target.value })} placeholder="https://your-secure-bridge.example" style={fieldStyle}/></label>
            <label><span style={labelStyle}>BRIDGE API KEY</span><input required value={form.bridgeApiKey} onChange={e => setForm({ ...form, bridgeApiKey: e.target.value })} placeholder={status?.hasApiKey ? 'Saved — enter to replace' : 'Provided by bridge administrator'} style={fieldStyle}/></label>
            <label><span style={labelStyle}>BRIDGE SECRET</span><input required type="password" value={form.bridgeSecret} onChange={e => setForm({ ...form, bridgeSecret: e.target.value })} placeholder={status?.hasBridgeSecret ? 'Saved — enter to replace' : 'Unique long bridge signing secret'} style={fieldStyle}/></label>
            <label><span style={labelStyle}>TERMINAL ID</span><input required value={form.terminalId} onChange={e => setForm({ ...form, terminalId: e.target.value })} style={fieldStyle}/></label>
            <label><span style={labelStyle}>ACCOUNT ENVIRONMENT</span><select value={form.environment} onChange={e => setForm({ ...form, environment: e.target.value })} style={fieldStyle}><option value="free_trial">FTMO Free Trial</option><option value="challenge">FTMO Challenge</option><option value="verification">Verification</option><option value="funded">FTMO Account</option></select></label>
            <label><span style={labelStyle}>ACCOUNT MODEL</span><select value={form.accountModel} onChange={e => setForm({ ...form, accountModel: e.target.value })} style={fieldStyle}><option value="demo">Demo</option><option value="one_step">1-Step</option><option value="two_step">2-Step</option><option value="funded">Funded</option></select></label>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <button disabled={saving} type="submit" style={{ border: '1px solid rgba(14,165,233,.4)', background: 'rgba(14,165,233,.14)', color: '#38bdf8', borderRadius: 6, padding: '8px 14px', fontSize: 10, fontWeight: 800, cursor: 'pointer' }}>{saving ? 'SAVING…' : 'SAVE CONNECTION'}</button>
            <button disabled={testing || !status} type="button" onClick={testConnection} style={{ border: '1px solid rgba(16,185,129,.4)', background: 'rgba(16,185,129,.12)', color: '#34d399', borderRadius: 6, padding: '8px 14px', fontSize: 10, fontWeight: 800, cursor: 'pointer' }}>{testing ? 'TESTING…' : 'TEST BRIDGE'}</button>
          </div>
          {message && <div style={{ marginTop: 12, fontSize: 10, color: message.toLowerCase().includes('success') || message.toLowerCase().includes('saved') ? '#34d399' : '#fbbf24' }}>{message}</div>}
        </form>
      </section>

      <section style={{ background: '#0f172a', border: '1px solid rgba(139,92,246,.28)', borderRadius: 8, padding: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 800, color: '#f1f5f9', marginBottom: 4 }}>Where to find each connector value</div>
        <div style={{ fontSize: 10, color: '#64748b', lineHeight: 1.5, marginBottom: 12 }}>FTMO provides the trading account credentials. Your Signal Stack MT5 bridge deployment provides the bridge connection values.</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 8 }}>
          {setupSteps.map(step => <div key={step.title} style={{ background: '#020817', border: '1px solid #1e293b', borderRadius: 7, padding: 11 }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: '#c4b5fd', marginBottom: 4 }}>{step.title}</div>
            <div style={{ fontSize: 8, fontWeight: 800, color: '#38bdf8', letterSpacing: '.06em', marginBottom: 6 }}>{step.source.toUpperCase()}</div>
            <div style={{ fontSize: 9, color: '#94a3b8', lineHeight: 1.55 }}>{step.directions}</div>
          </div>)}
        </div>
        <div style={{ marginTop: 12, background: 'rgba(245,158,11,.07)', border: '1px solid rgba(245,158,11,.25)', borderRadius: 7, padding: 11 }}>
          <div style={{ fontSize: 9, fontWeight: 800, color: '#fbbf24', marginBottom: 5 }}>PLATFORM ADMIN ONLY — RAILWAY ENCRYPTION KEY</div>
          <div style={{ fontSize: 9, color: '#94a3b8', lineHeight: 1.55 }}><code style={{ color: '#e2e8f0' }}>FTMO_CREDENTIAL_ENCRYPTION_KEY</code> is not supplied by FTMO. Generate it once with <code style={{ color: '#e2e8f0' }}>openssl rand -hex 32</code>, then open Railway → Signal Stack service → Variables → New Variable, paste the generated value, and redeploy. Clients should never see or enter this key.</div>
        </div>
      </section>
    </div>

    <aside style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8, padding: 16, alignSelf: 'start' }}>
      <div style={{ fontSize: 11, fontWeight: 800, color: '#cbd5e1', marginBottom: 12 }}>CLIENT CONNECTION STATUS</div>
      {loading ? <div style={{ fontSize: 10, color: '#64748b' }}>Loading…</div> : status ? <div style={{ display: 'grid', gap: 9 }}>
        {[
          ['Status', status.connected ? 'CONNECTED' : String(status.status || 'SAVED').toUpperCase()],
          ['Login', status.accountLoginMasked || '—'],
          ['Server', status.server || '—'],
          ['Terminal', status.terminalId || '—'],
          ['Environment', status.environment || '—'],
          ['Account model', status.accountModel || '—'],
          ['Last tested', status.lastTestedAt ? new Date(status.lastTestedAt).toLocaleString() : 'Not tested'],
        ].map(([label, value]) => <div key={label} style={{ borderBottom: '1px solid #1e293b', paddingBottom: 7 }}><div style={{ fontSize: 8, color: '#475569', marginBottom: 3 }}>{label.toUpperCase()}</div><div style={{ fontSize: 10, color: label === 'Status' ? (status.connected ? '#34d399' : '#fbbf24') : '#cbd5e1', wordBreak: 'break-word' }}>{value}</div></div>)}
        {status.lastError && <div style={{ border: '1px solid rgba(239,68,68,.25)', background: 'rgba(239,68,68,.08)', borderRadius: 6, padding: 8, fontSize: 9, color: '#f87171' }}>{status.lastError}</div>}
      </div> : <div style={{ fontSize: 10, color: '#64748b', lineHeight: 1.6 }}>No FTMO connection has been saved for this client login.</div>}
    </aside>
  </div>;
}
