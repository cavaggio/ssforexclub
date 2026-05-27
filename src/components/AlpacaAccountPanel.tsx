import React, { useState, useEffect } from 'react';
import { alpacaApi, AlpacaAccount, AlpacaPosition } from '../services/alpacaApi';

const DollarIcon = () => (
  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="1" x2="12" y2="23" /><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
  </svg>
);

const TrendingUpIcon = ({ size = 32 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" /><polyline points="17 6 23 6 23 12" />
  </svg>
);

const AlertIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
  </svg>
);

const RefreshIcon = ({ spinning }: { spinning: boolean }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
    style={spinning ? { animation: 'spin 1s linear infinite' } : {}}>
    <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
  </svg>
);

const ActivityIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
  </svg>
);

const card: React.CSSProperties = {
  background: '#fff',
  borderRadius: '12px',
  boxShadow: '0 2px 12px rgba(0,0,0,0.08)',
  padding: '24px',
};

export const AlpacaAccountPanel: React.FC = () => {
  const [account, setAccount] = useState<AlpacaAccount | null>(null);
  const [positions, setPositions] = useState<AlpacaPosition[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastUpdate, setLastUpdate] = useState<Date>(new Date());

  const fetchAccountData = async () => {
    try {
      setIsLoading(true);
      setError('');
      const [accountData, positionsData] = await Promise.all([
        alpacaApi.getAccount(),
        alpacaApi.getPositions(),
      ]);
      setAccount(accountData);
      setPositions(positionsData);
      setLastUpdate(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch account data');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchAccountData();
    const interval = setInterval(fetchAccountData, 30000);
    return () => clearInterval(interval);
  }, []);

  const fmt = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(n);
  const fmtPct = (p: number) => `${p >= 0 ? '+' : ''}${p.toFixed(2)}%`;

  if (isLoading && !account) {
    return (
      <div style={card}>
        <div style={{ color: '#6b7280', fontSize: '14px' }}>Loading account data...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', color: '#dc2626' }}>
          <AlertIcon />
          <div>
            <p style={{ fontWeight: 600, margin: '0 0 4px' }}>Connection Error</p>
            <p style={{ fontSize: '14px', margin: '0 0 8px', color: '#ef4444' }}>{error}</p>
            <button
              onClick={fetchAccountData}
              style={{ fontSize: '13px', background: '#fee2e2', border: 'none', borderRadius: '6px', padding: '4px 12px', cursor: 'pointer', color: '#dc2626' }}
            >
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!account) return null;

  const totalUnrealizedPL = positions.reduce((sum, pos) => sum + pos.unrealizedPL, 0);
  const dayTradeWarning = account.daytradeCount >= 3;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
          <h2 style={{ fontSize: '18px', fontWeight: 700, color: '#111827', margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ color: '#2563eb' }}><ActivityIcon /></span>
            Alpaca Account
          </h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button
              onClick={fetchAccountData}
              disabled={isLoading}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280', padding: '6px', borderRadius: '6px', display: 'flex' }}
            >
              <RefreshIcon spinning={isLoading} />
            </button>
            <span style={{ fontSize: '12px', color: '#9ca3af' }}>Updated: {lastUpdate.toLocaleTimeString()}</span>
          </div>
        </div>

        {(account.tradingBlocked || account.accountBlocked || dayTradeWarning) && (
          <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '8px', padding: '16px', marginBottom: '24px', display: 'flex', gap: '12px' }}>
            <span style={{ color: '#dc2626', flexShrink: 0 }}><AlertIcon /></span>
            <div style={{ fontSize: '13px' }}>
              <p style={{ fontWeight: 600, color: '#991b1b', margin: '0 0 4px' }}>Account Restrictions</p>
              <ul style={{ color: '#b91c1c', margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '2px' }}>
                {account.tradingBlocked && <li>• Trading is currently blocked</li>}
                {account.accountBlocked && <li>• Account is blocked</li>}
                {dayTradeWarning && <li>• Day trade limit warning ({account.daytradeCount}/3 used)</li>}
              </ul>
            </div>
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '16px' }}>
          <div style={{ background: 'linear-gradient(135deg, #eff6ff, #dbeafe)', borderRadius: '10px', padding: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <p style={{ fontSize: '13px', fontWeight: 500, color: '#2563eb', margin: '0 0 4px' }}>Portfolio Value</p>
                <p style={{ fontSize: '22px', fontWeight: 700, color: '#1e3a8a', margin: 0 }}>{fmt(account.portfolioValue)}</p>
              </div>
              <span style={{ color: '#2563eb' }}><DollarIcon /></span>
            </div>
          </div>

          <div style={{ background: 'linear-gradient(135deg, #f0fdf4, #dcfce7)', borderRadius: '10px', padding: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <p style={{ fontSize: '13px', fontWeight: 500, color: '#16a34a', margin: '0 0 4px' }}>Buying Power</p>
                <p style={{ fontSize: '22px', fontWeight: 700, color: '#14532d', margin: 0 }}>{fmt(account.buyingPower)}</p>
              </div>
              <span style={{ color: '#16a34a' }}><TrendingUpIcon /></span>
            </div>
          </div>

          <div style={{
            background: totalUnrealizedPL >= 0 ? 'linear-gradient(135deg, #f0fdf4, #dcfce7)' : 'linear-gradient(135deg, #fef2f2, #fee2e2)',
            borderRadius: '10px', padding: '16px',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <p style={{ fontSize: '13px', fontWeight: 500, color: totalUnrealizedPL >= 0 ? '#16a34a' : '#dc2626', margin: '0 0 4px' }}>Unrealized P&L</p>
                <p style={{ fontSize: '22px', fontWeight: 700, color: totalUnrealizedPL >= 0 ? '#14532d' : '#991b1b', margin: 0 }}>{fmt(totalUnrealizedPL)}</p>
              </div>
              <span style={{ color: totalUnrealizedPL >= 0 ? '#16a34a' : '#dc2626' }}>
                <TrendingUpIcon />
              </span>
            </div>
          </div>
        </div>

        <div style={{ marginTop: '24px', display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '16px', fontSize: '14px' }}>
          <div>
            <p style={{ color: '#6b7280', margin: '0 0 2px' }}>Cash</p>
            <p style={{ fontWeight: 600, color: '#111827', margin: 0 }}>{fmt(account.cash)}</p>
          </div>
          <div>
            <p style={{ color: '#6b7280', margin: '0 0 2px' }}>Day Trades</p>
            <p style={{ fontWeight: 600, color: '#111827', margin: 0 }}>{account.daytradeCount}/3</p>
          </div>
          <div>
            <p style={{ color: '#6b7280', margin: '0 0 2px' }}>Account Status</p>
            <p style={{ fontWeight: 600, color: account.status === 'ACTIVE' ? '#16a34a' : '#dc2626', margin: 0 }}>{account.status}</p>
          </div>
          <div>
            <p style={{ color: '#6b7280', margin: '0 0 2px' }}>PDT Status</p>
            <p style={{ fontWeight: 600, color: account.patternDayTrader ? '#ea580c' : '#16a34a', margin: 0 }}>
              {account.patternDayTrader ? 'PDT' : 'Regular'}
            </p>
          </div>
        </div>
      </div>

      {positions.length > 0 && (
        <div style={card}>
          <h3 style={{ fontSize: '16px', fontWeight: 700, color: '#111827', margin: '0 0 16px' }}>Current Positions</h3>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
              <thead>
                <tr style={{ borderBottom: '2px solid #e5e7eb' }}>
                  {['Symbol', 'Qty', 'Avg Price', 'Market Value', 'P&L', 'P&L %'].map((h, i) => (
                    <th key={h} style={{ padding: '8px', textAlign: i === 0 ? 'left' : 'right', color: '#6b7280', fontWeight: 600, whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {positions.map((pos, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid #f3f4f6' }}>
                    <td style={{ padding: '12px 8px', fontWeight: 600, color: '#111827' }}>{pos.symbol}</td>
                    <td style={{ padding: '12px 8px', textAlign: 'right', color: '#374151' }}>{pos.qty}</td>
                    <td style={{ padding: '12px 8px', textAlign: 'right', color: '#374151' }}>{fmt(pos.avgEntryPrice)}</td>
                    <td style={{ padding: '12px 8px', textAlign: 'right', color: '#374151' }}>{fmt(pos.marketValue)}</td>
                    <td style={{ padding: '12px 8px', textAlign: 'right', fontWeight: 600, color: pos.unrealizedPL >= 0 ? '#16a34a' : '#dc2626' }}>
                      {fmt(pos.unrealizedPL)}
                    </td>
                    <td style={{ padding: '12px 8px', textAlign: 'right', fontWeight: 600, color: pos.unrealizedPLPercent >= 0 ? '#16a34a' : '#dc2626' }}>
                      {fmtPct(pos.unrealizedPLPercent * 100)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
