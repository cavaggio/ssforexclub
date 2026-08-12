'use client';

import { useCallback, useEffect, useState } from 'react';

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | {
      kind: 'ready';
      enabled: boolean;
      migrationRequired: boolean;
      platformEnabled: boolean;
      liveAck: boolean;
      environment: string;
      saving: boolean;
      saveError: string | null;
    };

export function AutoCloseToggle() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/user/auto-close', { cache: 'no-store' });
      const json = await response.json().catch(() => ({}));
      if (!response.ok || !json?.ok) {
        setState({ kind: 'error', message: json?.error || `HTTP ${response.status}` });
        return;
      }
      setState({
        kind: 'ready',
        enabled: Boolean(json.autoCloseEnabled),
        migrationRequired: Boolean(json.migrationRequired),
        platformEnabled: Boolean(json.platformLiveTradingEnabled),
        liveAck: Boolean(json.liveTradingAcknowledged),
        environment: typeof json.activeEnvironment === 'string' ? json.activeEnvironment : 'practice',
        saving: false,
        saveError: null,
      });
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const toggle = async () => {
    if (state.kind !== 'ready' || state.saving || state.migrationRequired) return;
    const isPaper = state.environment === 'practice' || state.environment === 'paper';
    if (!isPaper && (!state.platformEnabled || !state.liveAck)) return;

    const previous = state;
    setState({ ...state, saving: true, saveError: null });
    try {
      const response = await fetch('/api/user/auto-close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !state.enabled }),
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok || !json?.ok) {
        setState({
          ...previous,
          saving: false,
          saveError: json?.error || `Could not save Auto Profit Protection (HTTP ${response.status}).`,
        });
        return;
      }
      setState({
        ...state,
        enabled: Boolean(json.autoCloseEnabled),
        saving: false,
        saveError: null,
      });
    } catch (err) {
      setState({
        ...previous,
        saving: false,
        saveError: err instanceof Error ? err.message : 'Could not save Auto Profit Protection.',
      });
    }
  };

  if (state.kind === 'loading') {
    return <Box><span style={{ color: 'var(--muted)', fontSize: 13 }}>Loading Auto Profit Protection…</span></Box>;
  }
  if (state.kind === 'error') {
    return <Box><span style={{ color: 'var(--bad)', fontSize: 13 }}>Auto Profit Protection: {state.message}</span></Box>;
  }

  const isPaper = state.environment === 'practice' || state.environment === 'paper';
  const liveGateReady = isPaper || (state.platformEnabled && state.liveAck);
  const disabled = state.migrationRequired || !liveGateReady;
  const active = state.enabled && !disabled;

  return (
    <Box>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 540px' }}>
          <div style={{ fontWeight: 800, fontSize: 14 }}>Auto Profit Protection</div>
          <div style={{ marginTop: 4, color: 'var(--muted)', fontSize: 12, lineHeight: 1.55 }}>
            Reviews open trades every five minutes. It can move the stop to breakeven when applicable,
            bank one partial while momentum is favorable, and trail the protected runner only after price
            reaches the original take-profit threshold.
          </div>
          <div style={{ marginTop: 7, fontSize: 12 }}>
            Status:{' '}
            <strong style={{ color: active ? 'var(--good)' : 'var(--muted)' }}>
              {active ? 'ACTIVE — broker profit protection enabled' : 'OFF — recommendations only'}
            </strong>
          </div>
        </div>

        <button
          type="button"
          onClick={() => void toggle()}
          disabled={disabled || state.saving}
          aria-pressed={active}
          style={{
            minWidth: 92,
            padding: '9px 15px',
            borderRadius: 8,
            border: '1px solid var(--border)',
            fontWeight: 800,
            fontSize: 13,
            background: active ? 'var(--good)' : 'var(--border)',
            color: active ? '#06210f' : 'var(--text)',
            cursor: disabled ? 'not-allowed' : state.saving ? 'wait' : 'pointer',
            opacity: disabled ? 0.55 : 1,
          }}
        >
          {state.saving ? '…' : active ? 'ON' : 'OFF'}
        </button>
      </div>

      <div style={{ marginTop: 10, padding: '9px 11px', border: '1px dashed var(--border)', borderRadius: 8, color: 'var(--muted)', fontSize: 11, lineHeight: 1.5 }}>
        Automatic management never widens a stop, adds to a losing trade, or fully closes before the protective SL. The SL remains the loss authority; the bot protects profit instead of guessing an early exit.
      </div>

      {state.migrationRequired && (
        <div role="alert" style={{ marginTop: 9, color: 'var(--warn)', fontSize: 12 }}>
          Apply <code>20260803003000_active_exit_intelligence.sql</code> in Supabase before enabling this toggle.
        </div>
      )}
      {!isPaper && !state.platformEnabled && (
        <div role="alert" style={{ marginTop: 9, color: 'var(--warn)', fontSize: 12 }}>
          Live Auto Profit Protection is blocked while PLATFORM_LIVE_TRADING_ENABLED is off.
        </div>
      )}
      {!isPaper && state.platformEnabled && !state.liveAck && (
        <div role="alert" style={{ marginTop: 9, color: 'var(--warn)', fontSize: 12 }}>
          Accept the live-trading risk acknowledgement before activating automatic profit protection.
        </div>
      )}
      {state.saveError && (
        <div role="alert" style={{ marginTop: 9, color: 'var(--bad)', fontSize: 12 }}>
          {state.saveError}
        </div>
      )}
    </Box>
  );
}

function Box({ children }: { children: React.ReactNode }) {
  return (
    <section style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 12, padding: 16, marginBottom: 14 }}>
      {children}
    </section>
  );
}
