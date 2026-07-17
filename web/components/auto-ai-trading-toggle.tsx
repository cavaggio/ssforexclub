/**
 * web/components/auto-ai-trading-toggle.tsx
 *
 * Dashboard "Auto AI Trading" toggle. Controls AI AUTO-trading only (not manual
 * execution). Persisted per user via /api/user/auto-ai-trading (Clerk-scoped).
 */

'use client';

import { useCallback, useEffect, useState } from 'react';

type Engine = 'ict' | 'v3' | 'ppr';

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | {
      kind: 'ready';
      enabled: boolean;
      engine: Engine;
      platformEnabled: boolean;
      liveAck: boolean;
      environment: string;
      saving: boolean;
      saveError: string | null;
    };

function normalizeEngine(value: unknown): Engine {
  if (value === 'v3' || value === 'ppr') return value;
  return 'ict';
}

const ENGINE_DESCRIPTIONS: Record<Engine, string> = {
  ict: 'ICT concepts and ICT-specific confirmation/execution.',
  v3: 'Independent V3 raw-market structure and liquidity engine.',
  ppr: 'Daily EMA bias, swing-liquidity targets, volume spike, and manipulation confirmation.',
};

export function AutoAiTradingToggle() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/user/auto-ai-trading', { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok || !json?.ok) {
        setState({ kind: 'error', message: json?.error || `HTTP ${res.status}` });
        return;
      }
      setState({
        kind: 'ready',
        enabled: !!json.autoAiTradingEnabled,
        engine: normalizeEngine(json.autoAiEngine),
        platformEnabled: !!json.platformLiveTradingEnabled,
        liveAck: !!json.liveTradingAcknowledged,
        environment: typeof json.activeEnvironment === 'string' ? json.activeEnvironment : 'practice',
        saving: false,
        saveError: null,
      });
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // One persisted field guarantees mutual exclusivity: only one engine can run.
  const save = async (next: { enabled: boolean; engine: Engine }) => {
    if (state.kind !== 'ready' || state.saving) return;
    const paper = state.environment === 'practice' || state.environment === 'paper';
    if (!paper && !state.platformEnabled) return;

    setState({ ...state, saving: true, saveError: null });
    try {
      const res = await fetch('/api/user/auto-ai-trading', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.ok) {
        setState({
          ...state,
          saving: false,
          saveError: json?.error || `Could not save Auto AI engine (HTTP ${res.status}).`,
        });
        return;
      }
      setState({
        ...state,
        enabled: !!json.autoAiTradingEnabled,
        engine: normalizeEngine(json.autoAiEngine),
        saving: false,
        saveError: null,
      });
    } catch (err) {
      setState({
        ...state,
        saving: false,
        saveError: err instanceof Error ? err.message : 'Could not save Auto AI engine.',
      });
    }
  };

  const toggle = () => {
    if (state.kind === 'ready') void save({ enabled: !state.enabled, engine: state.engine });
  };
  const chooseEngine = (engine: Engine) => {
    if (state.kind === 'ready') void save({ enabled: state.enabled, engine });
  };

  if (state.kind === 'loading') {
    return <Box><span style={{ color: 'var(--muted)', fontSize: 13 }}>Loading Auto AI Trading…</span></Box>;
  }
  if (state.kind === 'error') {
    return <Box><span style={{ color: 'var(--bad)', fontSize: 13 }}>Auto AI Trading: {state.message}</span></Box>;
  }

  const isPaper = state.environment === 'practice' || state.environment === 'paper';
  const platformOk = isPaper || state.platformEnabled;
  const on = state.enabled && platformOk;
  const disabled = !platformOk;

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
            minWidth: 84,
            padding: '8px 14px',
            borderRadius: 8,
            fontWeight: 800,
            fontSize: 13,
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

      <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>Engine:</span>
        {(['ict', 'v3', 'ppr'] as Engine[]).map((engine) => {
          const active = state.engine === engine;
          return (
            <button
              key={engine}
              onClick={() => chooseEngine(engine)}
              disabled={disabled || state.saving}
              aria-pressed={active}
              title={ENGINE_DESCRIPTIONS[engine]}
              style={{
                padding: '6px 14px',
                borderRadius: 8,
                fontSize: 12,
                fontWeight: 800,
                cursor: disabled ? 'not-allowed' : state.saving ? 'wait' : 'pointer',
                border: `1px solid ${active ? 'var(--good)' : 'var(--border)'}`,
                background: active ? 'var(--good)' : 'transparent',
                color: active ? '#06210f' : 'var(--text)',
                opacity: disabled ? 0.55 : 1,
              }}
            >
              {engine.toUpperCase()}
            </button>
          );
        })}
      </div>

      <div style={{ marginTop: 6, fontSize: 11, color: 'var(--muted)', fontStyle: 'italic' }}>
        {ENGINE_DESCRIPTIONS[state.engine]} Only one auto-trading engine can be active at a time.
      </div>

      {state.saveError && (
        <div
          role="alert"
          style={{
            marginTop: 10,
            padding: '9px 11px',
            border: '1px solid var(--bad)',
            borderRadius: 8,
            color: 'var(--bad)',
            fontSize: 12,
            lineHeight: 1.45,
          }}
        >
          {state.saveError}
        </div>
      )}

      {disabled && (
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--warn)' }}>
          Disabled by platform — live auto-trading is turned off (PLATFORM_LIVE_TRADING_ENABLED). Your preference is saved but won’t run until the platform enables it.
        </div>
      )}
      {isPaper && state.enabled && (
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--muted)' }}>
          Paper mode — runs on your practice account. No live-trading acknowledgement or platform flag required.
        </div>
      )}
      {!disabled && !isPaper && state.enabled && !state.liveAck && (
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
