'use client';

import { useState } from 'react';

type Props = {
  connected: boolean;
  liveExecutionEnabled: boolean;
  orderTestVerified: boolean;
  marketClosedMessage?: string | null;
};

const CONFIRMATION = 'PLACE FTMO TEST ORDER';

export function FtmoOrderTestControl({ connected, liveExecutionEnabled, orderTestVerified, marketClosedMessage }: Props) {
  const [symbol, setSymbol] = useState('EUR_USD');
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [confirmation, setConfirmation] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  const enabled = connected && liveExecutionEnabled && !orderTestVerified && !marketClosedMessage && confirmation === CONFIRMATION && !pending;

  async function submit() {
    if (!enabled) return;
    setPending(true);
    setMessage(null);
    setOk(false);
    try {
      const response = await fetch('/api/ftmo/order-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, side, volume: 0.01, confirmation }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setMessage(String(body?.error || `Order test failed with HTTP ${response.status}`));
        return;
      }
      setOk(true);
      setMessage(String(body?.message || 'FTMO test order queued. Verify the MT5 fill before proceeding.'));
      setConfirmation('');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <section style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 10, padding: 24 }}>
      <h3 style={{ margin: 0, fontSize: 16 }}>Controlled MT5 Order Test</h3>
      <p style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.6, marginTop: 8 }}>
        This sends one real 0.01-lot test order to the active FTMO Verification account. It does not enable autonomous trading. The EA applies the same 15-pip SL, +10-pip breakeven, 80% at +15 pips, and final 20% at +18 pips.
      </p>

      {orderTestVerified ? (
        <div style={{ marginTop: 14, color: 'var(--good)', fontWeight: 800, fontSize: 13 }}>
          ✓ Minimum-volume MT5 order test verified
        </div>
      ) : (
        <>
          {!connected && <p style={{ color: 'var(--bad)', fontSize: 12 }}>MT5 EA must be connected first.</p>}
          {!liveExecutionEnabled && (
            <p style={{ color: 'var(--warn)', fontSize: 12 }}>
              FTMO_LIVE_EXECUTION_ENABLED is still false. Keep it false until the market is open and you are ready to run this single controlled test.
            </p>
          )}
          {marketClosedMessage && <p style={{ color: 'var(--warn)', fontSize: 12 }}>{marketClosedMessage}</p>}

          <div style={{ marginTop: 16, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
              <span style={{ color: 'var(--muted)' }}>Pair</span>
              <select value={symbol} onChange={(event) => setSymbol(event.target.value)} style={inputStyle}>
                <option value="EUR_USD">EUR_USD</option>
                <option value="GBP_USD">GBP_USD</option>
                <option value="USD_JPY">USD_JPY</option>
                <option value="GBP_JPY">GBP_JPY</option>
              </select>
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
              <span style={{ color: 'var(--muted)' }}>Side</span>
              <select value={side} onChange={(event) => setSide(event.target.value as 'buy' | 'sell')} style={inputStyle}>
                <option value="buy">Buy</option>
                <option value="sell">Sell</option>
              </select>
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
              <span style={{ color: 'var(--muted)' }}>Volume</span>
              <input value="0.01 lots" readOnly style={inputStyle} />
            </label>
          </div>

          <label style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
            <span style={{ color: 'var(--muted)' }}>Type exactly: <strong style={{ color: 'var(--text)' }}>{CONFIRMATION}</strong></span>
            <input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" style={inputStyle} />
          </label>

          <button
            type="button"
            onClick={submit}
            disabled={!enabled}
            style={{
              marginTop: 14,
              padding: '10px 14px',
              borderRadius: 7,
              border: '1px solid var(--border)',
              background: enabled ? 'var(--bad)' : 'var(--bg)',
              color: enabled ? 'white' : 'var(--muted)',
              fontWeight: 800,
              cursor: enabled ? 'pointer' : 'not-allowed',
            }}
          >
            {pending ? 'Queueing test…' : 'Place 0.01-lot FTMO test order'}
          </button>
        </>
      )}

      {message && (
        <div style={{ marginTop: 12, fontSize: 12, color: ok ? 'var(--good)' : 'var(--bad)', lineHeight: 1.5 }}>
          {message}
        </div>
      )}
    </section>
  );
}

const inputStyle: React.CSSProperties = {
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  padding: '9px 10px',
  color: 'var(--text)',
  fontFamily: 'inherit',
};
