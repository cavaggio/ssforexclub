'use client';

import { useEffect } from 'react';

export default function ApplicationError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[application] route render failed:', error);
  }, [error]);

  return (
    <main
      role="alert"
      style={{
        minHeight: '70vh',
        display: 'grid',
        placeItems: 'center',
        padding: 24,
      }}
    >
      <section
        style={{
          width: 'min(680px, 100%)',
          background: 'var(--panel)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          padding: 28,
        }}
      >
        <div style={{ color: 'var(--bad)', fontSize: 12, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 1 }}>
          Application recovery
        </div>
        <h1 style={{ margin: '8px 0 0', fontSize: 24 }}>Signal Stack could not finish loading this route.</h1>
        <p style={{ color: 'var(--muted)', fontSize: 13, lineHeight: 1.6, margin: '10px 0 0' }}>
          The error was contained and no trading configuration was changed. Retry the request or reload the current application bundle.
        </p>
        {error.digest ? (
          <p style={{ color: 'var(--muted)', fontSize: 11, marginTop: 10 }}>
            Error reference: <code>{error.digest}</code>
          </p>
        ) : null}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 20 }}>
          <button
            type="button"
            onClick={reset}
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
            Retry route
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
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
    </main>
  );
}
