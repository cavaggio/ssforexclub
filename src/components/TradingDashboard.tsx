import React, { useState } from 'react';
import { AlpacaAccountPanel } from './AlpacaAccountPanel';
import { AlpacaSetup } from './AlpacaSetup';

interface TradingDashboardProps {
  username: string;
  onLogout: () => void;
}

const UserIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </svg>
);

const LogOutIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <polyline points="16 17 21 12 16 7" />
    <line x1="21" y1="12" x2="9" y2="12" />
  </svg>
);

const headerStyle: React.CSSProperties = {
  background: '#fff',
  borderBottom: '1px solid #e5e7eb',
  boxShadow: '0 1px 3px rgba(0,0,0,0.07)',
};

const headerInnerStyle: React.CSSProperties = {
  maxWidth: '1200px',
  margin: '0 auto',
  padding: '0 24px',
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  height: '64px',
};

const mainStyle: React.CSSProperties = {
  maxWidth: '1200px',
  margin: '0 auto',
  padding: '32px 24px',
};

export const TradingDashboard: React.FC<TradingDashboardProps> = ({ username, onLogout }) => {
  const [hasAlpacaCredentials, setHasAlpacaCredentials] = useState(false);

  return (
    <div style={{ minHeight: '100vh', background: '#f9fafb', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      <header style={headerStyle}>
        <div style={headerInnerStyle}>
          <h1 style={{ fontSize: '18px', fontWeight: 700, color: '#111827', margin: 0 }}>
            AI Trading Dashboard
          </h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '14px', color: '#6b7280' }}>
              <UserIcon />
              <span>{username}</span>
            </div>
            <button
              onClick={onLogout}
              style={{
                display: 'flex', alignItems: 'center', gap: '6px',
                background: 'none', border: 'none', cursor: 'pointer',
                fontSize: '14px', color: '#6b7280', padding: '6px 10px',
                borderRadius: '6px', transition: 'color 0.15s',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.color = '#111827')}
              onMouseLeave={(e) => (e.currentTarget.style.color = '#6b7280')}
            >
              <LogOutIcon />
              <span>Logout</span>
            </button>
          </div>
        </div>
      </header>

      <main style={mainStyle}>
        {!hasAlpacaCredentials ? (
          <AlpacaSetup
            onSetupComplete={() => setHasAlpacaCredentials(true)}
            hasCredentials={hasAlpacaCredentials}
          />
        ) : (
          <AlpacaAccountPanel />
        )}
      </main>
    </div>
  );
};
