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
    <section style={{ background: '#0f172a', border: '1px solid rgba(14,165,233,.28)', borderRadius: 8, padding: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 800, color: '#f1f5f9', marginBottom: 4 }}>FTMO MT5 Connection</div>
      <div style={{ fontSize: 10, color: '#64748b', lineHeight: 1.5, marginBottom: 16 }}>Connection details are saved per authenticated client. API keys and bridge secrets are encrypted server-side and are never displayed after saving.</div>
      <form onSubmit={save}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <label><span style={labelStyle}>MT5 LOGIN</span><input required inputMode="numeric" value={form.accountLogin} onChange={e => setForm({ ...form, accountLogin: e.target.value })} placeholder={status?.accountLoginMasked || 'Demo login number'} style={fieldStyle}/></label>
          <label><span style={labelStyle}>FTMO SERVER</span><input required value={form.server} onChange={e => setForm({ ...form, server: e.target.value })} placeholder="FTMO-Demo2" style={fieldStyle}/></label>
          <label style={{ gridColumn: '1 / -1' }}><span style={labelStyle}>SECURE BRIDGE URL</span><input required type="url" value={form.bridgeUrl} onChange={e => setForm({ ...form, bridgeUrl: e.target.value })} placeholder="https://your-secure-bridge.example" style={fieldStyle}/></label>
          <label><span style={labelStyle}>BRIDGE API KEY</span><input required value={form.bridgeApiKey} onChange={e => setForm({ ...form, bridgeApiKey: e.target.value })} placeholder={status?.hasApiKey ? 'Saved — enter to replace' : 'API key'} style={fieldStyle}/></label>
          <label><span style={labelStyle}>BRIDGE SECRET</span><input required type="password" value={form.bridgeSecret} onChange={e => setForm({ ...form, bridgeSecret: e.target.value })} placeholder={status?.hasBridgeSecret ? 'Saved — enter to replace' : 'Minimum 16 characters'} style={fieldStyle}/></label>
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
