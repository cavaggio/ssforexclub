'use client';

import { useEffect } from 'react';

const RECOVERY_KEY = 'signal-stack-dashboard-chunk-recovery';
const STALE_ASSET_ERROR = /ChunkLoadError|Loading chunk|Failed to fetch dynamically imported module|CSS_CHUNK_LOAD_FAILED/i;

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[dashboard] route render failed:', error);

    // A deployment can leave an already-open browser tab holding an old Next.js
    // asset manifest. Recover once with a full navigation, but never enter a
    // reload loop when the failure is a real server or application error.
    if (!STALE_ASSET_ERROR.test(error.message || '')) return;

    try {
      if (sessionStorage.getItem(RECOVERY_KEY) === '1') return;
      sessionStorage.setItem(RECOVERY_KEY, '1');
      window.location.reload();
    } catch {
      // Storage can be unavailable in strict privacy modes. The manual controls
      // below remain usable.
    }
  }, [error]);

  const retry = () => {
    try {
      sessionStorage.removeItem(RECOVERY_KEY);
    } catch {}
    reset();
  };

  const hardReload = () => {
    try {
      sessionStorage.removeItem(RECOVERY_KEY);
    } catch {}
    window.location.reload();
  };

  return (
    <section
      role="alert"
      style={{
        maxWidth: 720,
        margin: '48px auto',
        background: 'var(--panel)',
        border: '1px solid var(--border)',
        borderRadius: 12,
        padding: 28,
      }}
    >
      <div style={{ color: 'var(--bad)', fontSize: 12, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 1 }}>
        Dashboard recovery
      </div>
      <h1 style={{ margin: '8px 0 0', fontSize: 24 }}>The dashboard hit a temporary loading error.</h1>
      <p style={{ color: 'var(--muted)', fontSize: 13, lineHeight: 1.6, margin: '10px 0 0' }}>
        Your trading settings were not changed. Retry the route first; use a full reload if the browser has a stale deployment bundle.
      </p>
      {error.digest ? (
        <p style={{ color: 'var(--muted)', fontSize: 11, marginTop: 10 }}>
          Error reference: <code>{error.digest}</code>
        </p>
      ) : null}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 20 }}>
        <button
          type="button"
          onClick={retry}
          style={{
            border: '1px solid var(--accent)',
            background: 'var(--accent)',
            color: '#06101a',
            borderRadius: 7,
            padding: '9px 16px',
            fontWeight: 800,
            cursor: 'pointer',
          }}
        >
          Retry dashboard
        </button>
        <button
          type="button"
          onClick={hardReload}
          style={{
            border: '1px solid var(--border)',
            background: 'var(--bg)',
            color: 'var(--text)',
            borderRadius: 7,
            padding: '9px 16px',
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          Reload application
        </button>
      </div>
    </section>
  );
}
