import React, { useState } from 'react';
import { alpacaApi } from '../services/alpacaApi';

interface AlpacaSetupProps {
  onSetupComplete: () => void;
  hasCredentials: boolean;
}

const ShieldIcon = ({ size = 32 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
  </svg>
);

const KeyIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
  </svg>
);

const AlertIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
    <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
  </svg>
);

const CheckIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />
  </svg>
);

const ExternalLinkIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    <polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" />
  </svg>
);

const inputStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '12px 16px',
  border: '1px solid #d1d5db',
  borderRadius: '8px',
  fontSize: '15px',
  outline: 'none',
  color: '#111827',
  background: '#fff',
};

export const AlpacaSetup: React.FC<AlpacaSetupProps> = ({ onSetupComplete, hasCredentials }) => {
  const [apiKey, setApiKey] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [paperTrading, setPaperTrading] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [showKeys, setShowKeys] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');
    try {
      await alpacaApi.setAlpacaCredentials(apiKey, secretKey, paperTrading);
      onSetupComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect to Alpaca');
    } finally {
      setIsLoading(false);
    }
  };

  if (hasCredentials) {
    return (
      <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '10px', padding: '24px', display: 'flex', gap: '12px', alignItems: 'flex-start', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
        <span style={{ color: '#16a34a', flexShrink: 0 }}><CheckIcon /></span>
        <div>
          <h3 style={{ fontSize: '16px', fontWeight: 600, color: '#14532d', margin: '0 0 4px' }}>Alpaca Connected</h3>
          <p style={{ fontSize: '14px', color: '#16a34a', margin: 0 }}>Your Alpaca account is successfully connected and ready for trading.</p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: '600px', margin: '0 auto', background: '#fff', borderRadius: '16px', boxShadow: '0 4px 24px rgba(0,0,0,0.08)', padding: '40px 32px', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      <div style={{ textAlign: 'center', marginBottom: '32px' }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
          <div style={{ background: '#dbeafe', padding: '14px', borderRadius: '50%', color: '#2563eb' }}>
            <ShieldIcon />
          </div>
        </div>
        <h2 style={{ fontSize: '22px', fontWeight: 700, color: '#111827', margin: '0 0 8px' }}>Connect Your Alpaca Account</h2>
        <p style={{ fontSize: '14px', color: '#6b7280', margin: 0 }}>
          Securely connect your Alpaca trading account to enable live trading functionality.
        </p>
      </div>

      <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: '10px', padding: '20px', marginBottom: '24px' }}>
        <h3 style={{ fontSize: '14px', fontWeight: 600, color: '#1e3a8a', margin: '0 0 12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <KeyIcon /> Getting Your API Keys
        </h3>
        <ol style={{ paddingLeft: '20px', margin: 0, color: '#1d4ed8', fontSize: '13px', lineHeight: '1.8' }}>
          <li>Visit the <a href="https://app.alpaca.markets/" target="_blank" rel="noopener noreferrer" style={{ color: '#2563eb', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>Alpaca Dashboard <ExternalLinkIcon /></a></li>
          <li>Navigate to "Your API Keys" in the right sidebar</li>
          <li>Generate new API keys (if you haven't already)</li>
          <li>Copy your API Key ID and Secret Key</li>
          <li>Choose Paper Trading for testing or Live Trading for real money</li>
        </ol>
      </div>

      <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: '10px', padding: '16px', marginBottom: '24px', display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
        <span style={{ color: '#d97706', flexShrink: 0 }}><AlertIcon /></span>
        <div style={{ fontSize: '13px' }}>
          <p style={{ fontWeight: 600, color: '#92400e', margin: '0 0 2px' }}>Security Notice</p>
          <p style={{ color: '#b45309', margin: 0 }}>
            Your API keys are encrypted and stored securely. Never share your secret key with anyone. Start with Paper Trading to test the system safely.
          </p>
        </div>
      </div>

      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
        <div>
          <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: '#374151', marginBottom: '8px' }}>API Key ID</label>
          <input
            type={showKeys ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="Enter your Alpaca API Key ID"
            required
            style={inputStyle}
            onFocus={(e) => { e.target.style.borderColor = '#2563eb'; e.target.style.boxShadow = '0 0 0 2px rgba(37,99,235,0.15)'; }}
            onBlur={(e) => { e.target.style.borderColor = '#d1d5db'; e.target.style.boxShadow = 'none'; }}
          />
        </div>

        <div>
          <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: '#374151', marginBottom: '8px' }}>Secret Key</label>
          <input
            type={showKeys ? 'text' : 'password'}
            value={secretKey}
            onChange={(e) => setSecretKey(e.target.value)}
            placeholder="Enter your Alpaca Secret Key"
            required
            style={inputStyle}
            onFocus={(e) => { e.target.style.borderColor = '#2563eb'; e.target.style.boxShadow = '0 0 0 2px rgba(37,99,235,0.15)'; }}
            onBlur={(e) => { e.target.style.borderColor = '#d1d5db'; e.target.style.boxShadow = 'none'; }}
          />
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '14px', color: '#6b7280', cursor: 'pointer' }}>
          <input type="checkbox" checked={showKeys} onChange={(e) => setShowKeys(e.target.checked)} />
          Show API keys
        </label>

        <div style={{ background: '#f9fafb', borderRadius: '10px', padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', cursor: 'pointer' }}>
            <input type="radio" name="tradingMode" checked={paperTrading} onChange={() => setPaperTrading(true)} style={{ marginTop: '3px' }} />
            <span>
              <span style={{ display: 'block', fontSize: '14px', fontWeight: 600, color: '#111827' }}>Paper Trading</span>
              <span style={{ display: 'block', fontSize: '13px', color: '#6b7280' }}>Test with virtual money (Recommended)</span>
            </span>
          </label>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', cursor: 'pointer' }}>
            <input type="radio" name="tradingMode" checked={!paperTrading} onChange={() => setPaperTrading(false)} style={{ marginTop: '3px' }} />
            <span>
              <span style={{ display: 'block', fontSize: '14px', fontWeight: 600, color: '#111827' }}>Live Trading</span>
              <span style={{ display: 'block', fontSize: '13px', color: '#dc2626' }}>Trade with real money (Use with caution)</span>
            </span>
          </label>
        </div>

        {error && (
          <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '8px', padding: '12px' }}>
            <p style={{ color: '#991b1b', fontSize: '14px', margin: 0 }}>{error}</p>
          </div>
        )}

        <button
          type="submit"
          disabled={isLoading || !apiKey || !secretKey}
          style={{
            width: '100%',
            background: isLoading || !apiKey || !secretKey ? '#93c5fd' : '#2563eb',
            color: '#fff',
            border: 'none',
            borderRadius: '8px',
            padding: '13px 16px',
            fontSize: '15px',
            fontWeight: 600,
            cursor: isLoading || !apiKey || !secretKey ? 'not-allowed' : 'pointer',
            transition: 'background 0.15s',
          }}
        >
          {isLoading ? 'Connecting...' : 'Connect Alpaca Account'}
        </button>
      </form>

      <div style={{ marginTop: '24px', textAlign: 'center' }}>
        <p style={{ fontSize: '13px', color: '#9ca3af', margin: 0 }}>
          Don't have an Alpaca account?{' '}
          <a href="https://alpaca.markets/" target="_blank" rel="noopener noreferrer" style={{ color: '#2563eb' }}>
            Sign up here
          </a>
        </p>
      </div>
    </div>
  );
};
