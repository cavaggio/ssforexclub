/**
 * web/components/auto-ai-trading-toggle.tsx
 *
 * Dashboard "Auto AI Trading" toggle. Controls AI AUTO-trading only (not manual
 * execution). Persisted per user via /api/user/auto-ai-trading (Clerk-scoped).
 *
 * Two-level gate: the platform env flag (PLATFORM_LIVE_TRADING_ENABLED) is the
 * upper gate — when it's off, the toggle renders disabled with a reason and
 * auto-trading cannot run regardless of the user's choice.
 */

'use client';

import { useCallback, useEffect, useState } from 'react';

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; enabled: boolean; engine: 'ict' | 'v3'; platformEnabled: boolean; liveAck: boolean; saving: boolean };

type Engine = 'ict' | 'v3';

export function AutoAiTradingToggle() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/user/auto-ai-trading', { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok || !json?.ok) { setState({ kind: 'error', message: json?.error || `HTTP ${res.status}` }); return; }
      setState({ kind: 'ready', enabled: !!json.autoAiTradingEnabled, engine: json.autoAiEngine === 'v3' ? 'v3' : 'ict', platformEnabled: !!json.platformLiveTradingEnabled, liveAck: !!json.liveTradingAcknowledged, saving: false });
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Single POST for both the on/off toggle and the engine selection — they share
  // one row, so only one engine can ever be active (mutual exclusivity).
  const save = async (next: { enabled: boolean; engine: Engine }) => {
    if (state.kind !== 'ready' || !state.platformEnabled || state.saving) return;
    setState({ ...state, saving: true });
    try {
      const res = await fetch('/api/user/auto-ai-trading', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next),
      });
      const json = await res.json();
      if (!res.ok || !json?.ok) { setState({ ...state, saving: false }); return; }
      setState({ ...state, enabled: !!json.autoAiTradingEnabled, engine: json.autoAiEngine === 'v3' ? 'v3' : 'ict', saving: false });
    } catch {
      setState({ ...state, saving: false });
    }
  };
  const toggle = () => { if (state.kind === 'ready') void save({ enabled: !state.enabled, engine: state.engine }); };
  const chooseEngine = (engine: Engine) => { if (state.kind === 'ready') void save({ enabled: state.enabled, engine }); };

  if (state.kind === 'loading') return <Box><span style={{ color: 'var(--muted)', fontSize: 13 }}>Loading Auto AI Trading…</span></Box>;
  if (state.kind === 'error') return <Box><span style={{ color: 'var(--bad)', fontSize: 13 }}>Auto AI Trading: {state.message}</span></Box>;

  const on = state.enabled && state.platformEnabled;
  const disabled = !state.platformEnabled;

  return (
    <Box>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontWeight: 800, fontSize: 14 }}>Auto AI Trading</div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            Controls AI <strong>auto-execution</strong> of qualified signals from the selected engine — not manual execution.
            {' '}When ON, the bot may scan and auto-execute; when OFF it analyzes only.
          </div>
          <div style={{ marginTop: 6, fontSize: 12 }}>
            Active engine:{' '}
            <strong style={{ color: on ? 'var(--good)' : 'var(--muted)' }}>
              {state.engine.toUpperCase()}{on ? '' : ' (off)'}
            </strong>
          </div>
        </div>
        <button
          onClick={() => toggle()}
          disabled={disabled || state.saving}
          aria-pressed={on}
          style={{
            minWidth: 84, padding: '8px 14px', borderRadius: 8, fontWeight: 800, fontSize: 13,
            cursor: disabled ? 'not-allowed' : state.saving ? 'wait' : 'pointer',
            border: '1px solid var(--border)',
            background: on ? 'var(--good)' : 'var(--border)',
            color: on ? '#06210f' : 'var(--text)',
            opacity: disabled ? 0.55 : 1,
          }}
        >
          {state.saving ? '…' : on ? 'ON' : 'OFF'}
        </button>
      </div>

      {/* Engine selector — exactly one engine (ICT or V3) can auto-trade. */}
      <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>Engine:</span>
        {(['ict', 'v3'] as Engine[]).map((e) => {
          const active = state.engine === e;
          return (
            <button
              key={e}
              onClick={() => chooseEngine(e)}
              disabled={disabled || state.saving}
              aria-pressed={active}
              style={{
                padding: '6px 14px', borderRadius: 8, fontSize: 12, fontWeight: 800,
                cursor: disabled ? 'not-allowed' : 'pointer',
                border: `1px solid ${active ? 'var(--good)' : 'var(--border)'}`,
                background: active ? 'var(--good)' : 'transparent',
                color: active ? '#06210f' : 'var(--text)',
                opacity: disabled ? 0.55 : 1,
              }}
            >
              {e.toUpperCase()}
            </button>
          );
        })}
      </div>
      <div style={{ marginTop: 6, fontSize: 11, color: 'var(--muted)', fontStyle: 'italic' }}>
        Only one auto-trading engine can be active at a time.
      </div>

      {disabled && (
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--warn)' }}>
          Disabled by platform — live auto-trading is turned off (PLATFORM_LIVE_TRADING_ENABLED). Your preference is saved but won’t run until the platform enables it.
        </div>
      )}
      {!disabled && state.enabled && !state.liveAck && (
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--warn)' }}>
          Note: live trading isn’t acknowledged yet — auto-trading also requires your live-trading acknowledgement and an active live broker connection.
        </div>
      )}
    </Box>
  );
}

function Box({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 12, padding: 16, marginBottom: 14 }}>
      {children}
    </div>
  );
}
