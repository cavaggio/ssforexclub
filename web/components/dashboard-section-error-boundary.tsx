'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';

type Props = {
  label: string;
  children: ReactNode;
};

type State = {
  hasError: boolean;
  message: string | null;
};

export class DashboardSectionErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, message: null };

  static getDerivedStateFromError(error: unknown): State {
    return {
      hasError: true,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(`[dashboard] ${this.props.label} section failed:`, error, info.componentStack);
  }

  private retry = () => {
    this.setState({ hasError: false, message: null });
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <section
        role="alert"
        style={{
          background: 'var(--panel)',
          border: '1px solid var(--warn)',
          borderRadius: 10,
          padding: 18,
        }}
      >
        <div style={{ color: 'var(--warn)', fontWeight: 800, fontSize: 14 }}>
          {this.props.label} temporarily unavailable
        </div>
        <p style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.5, margin: '7px 0 0' }}>
          This section hit a display error. The rest of the dashboard remains available and no trading settings were changed.
        </p>
        {this.state.message ? (
          <details style={{ marginTop: 8, color: 'var(--muted)', fontSize: 11 }}>
            <summary style={{ cursor: 'pointer' }}>Error detail</summary>
            <code style={{ display: 'block', marginTop: 6, overflowWrap: 'anywhere' }}>{this.state.message}</code>
          </details>
        ) : null}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
          <button
            type="button"
            onClick={this.retry}
            style={{
              border: '1px solid var(--accent)',
              background: 'var(--accent)',
              color: '#06101a',
              borderRadius: 6,
              padding: '7px 12px',
              fontWeight: 800,
              cursor: 'pointer',
            }}
          >
            Retry section
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              border: '1px solid var(--border)',
              background: 'var(--bg)',
              color: 'var(--text)',
              borderRadius: 6,
              padding: '7px 12px',
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            Reload dashboard
          </button>
        </div>
      </section>
    );
  }
}
